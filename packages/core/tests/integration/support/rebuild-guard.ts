/**
 * The cascade-rebuild scenario: Atlas rebuilds a SQLite table other tables reference, through
 * every kind of foreign key, and every row those tables hold must survive the rebuild's DROP
 * TABLE. One scenario, run on each engine through an executor of its own.
 */
import { spawnSync } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { classifyMigration } from "../../../src/migrate/core/classify.ts"
import { generateIncrementalMigration } from "../../../src/migrate/core/migrate-diff.ts"
import { extractSchema } from "../../../src/migrate/core/schema.ts"

/** What a scenario needs of an engine: run SQL, and read rows */
export type Engine = {
	rows(sql: string): Promise<Array<Record<string, unknown>>>
	run(sql: string): Promise<void>
	/** run one migration file the way the engine's apply would: all of it or none */
	apply(sql: string): Promise<void>
}

/* u: the parent Atlas rebuilds, with a NO ACTION self-reference; every other kind of reference hangs off it */
export const BASE = `CREATE TABLE \`u\` (\`id\` integer PRIMARY KEY AUTOINCREMENT, \`boss\` integer REFERENCES \`u\`(\`id\`), \`name\` text);
CREATE TABLE \`post\` (\`id\` integer PRIMARY KEY AUTOINCREMENT, \`author\` integer NOT NULL REFERENCES \`u\`(\`id\`) ON DELETE CASCADE, \`title\` text);
CREATE TABLE \`comment\` (\`id\` integer PRIMARY KEY, \`post\` integer REFERENCES \`post\`(\`id\`) ON DELETE CASCADE, \`body\` text, \`len\` integer AS (length(\`body\`)) VIRTUAL);
CREATE TABLE \`visit\` (\`who\` integer REFERENCES \`u\`(\`id\`) ON DELETE SET NULL, \`at\` integer);
CREATE TABLE \`membership\` (\`u\` integer NOT NULL REFERENCES \`u\`(\`id\`), \`team\` text NOT NULL, PRIMARY KEY (\`u\`, \`team\`)) WITHOUT ROWID;
CREATE TABLE \`vote\` (\`id\` integer PRIMARY KEY, \`comment\` integer REFERENCES \`comment\`(\`id\`) ON DELETE RESTRICT);
CREATE TABLE \`a\` (\`id\` integer PRIMARY KEY, \`u\` integer REFERENCES \`u\`(\`id\`) ON DELETE CASCADE, \`b\` integer REFERENCES \`b\`(\`id\`) ON DELETE CASCADE);
CREATE TABLE \`b\` (\`id\` integer PRIMARY KEY, \`a\` integer REFERENCES \`a\`(\`id\`) ON DELETE CASCADE);
`

/* post's search index: FTS5 over external content, kept by triggers */
export const FTS = `CREATE VIRTUAL TABLE IF NOT EXISTS post_fts USING fts5(title, content='post', content_rowid='id');

CREATE TRIGGER IF NOT EXISTS post_fts_ai AFTER INSERT ON post BEGIN
	INSERT INTO post_fts(rowid, title) VALUES (new.id, new.title);
END;

CREATE TRIGGER IF NOT EXISTS post_fts_ad AFTER DELETE ON post BEGIN
	INSERT INTO post_fts(post_fts, rowid, title) VALUES ('delete', old.id, old.title);
END;
`

/* the first rebuild changes u alone; the second changes u and post, the parent and its child */
export const REBUILD_U = BASE.replace("`name` text)", "`name` text NOT NULL DEFAULT '')")
export const REBUILD_BOTH = REBUILD_U.replace("DEFAULT '')", "DEFAULT 'x')").replace(
	"`title` text)",
	"`title` text NOT NULL DEFAULT '')",
)

export const SEED = `INSERT INTO u (id, boss, name) VALUES (1, NULL, 'ada'), (2, 1, 'bo'), (3, 2, 'cy');
INSERT INTO post (id, author, title) VALUES (1, 1, 'hello world'), (2, 2, 'hello there'), (3, 3, 'bye'), (4, 1, 'later'), (5, 2, 'gone');
DELETE FROM post WHERE id = 5;
INSERT INTO comment (id, post, body) VALUES (10, 1, 'nice'), (11, 2, 'ok'), (12, 4, 'wow');
INSERT INTO visit (who, at) VALUES (1, 100), (3, 200), (NULL, 300);
INSERT INTO membership (u, team) VALUES (1, 'red'), (2, 'red'), (2, 'blue');
INSERT INTO vote (id, comment) VALUES (20, 10), (21, 12);
INSERT INTO b (id, a) VALUES (30, NULL);
INSERT INTO a (id, u, b) VALUES (40, 1, 30), (41, 3, NULL);
UPDATE b SET a = 40 WHERE id = 30;
`

const TABLES = ["u", "post", "comment", "visit", "vote", "a", "b"]

/** Every row of every table with its rowid, the sequences, and what the search index finds */
export async function snapshot(engine: Engine): Promise<Record<string, unknown>> {
	const out: Record<string, unknown> = {}
	for (const table of TABLES) out[table] = await engine.rows(`SELECT rowid AS _rowid, * FROM ${table} ORDER BY 1`)
	out["membership"] = await engine.rows("SELECT * FROM membership ORDER BY 1, 2")
	out["sqlite_sequence"] = await engine.rows(
		"SELECT name, seq FROM sqlite_sequence WHERE name <> 'd1_migrations' ORDER BY name",
	)
	out["search"] = await engine.rows("SELECT rowid FROM post_fts WHERE post_fts MATCH 'hello' ORDER BY rowid")
	return out
}

/** What must hold after a guarded rebuild, beyond the rows: no broken key, a sound index, no keep table */
export async function soundness(engine: Engine): Promise<Record<string, unknown>> {
	await engine.run("INSERT INTO post_fts(post_fts, rank) VALUES('integrity-check', 1)")
	return {
		foreignKeyCheck: await engine.rows("PRAGMA foreign_key_check"),
		keepTables: await engine.rows("SELECT name FROM sqlite_master WHERE name LIKE '\\_comb\\_keep\\_%' ESCAPE '\\'"),
	}
}

/** A migrations directory and the diffs that fill it, on the real Atlas */
export type History = {
	/** a hand-written migration added, with atlas.sum rehashed */
	add(name: string, sql: string): void
	dir: string
	/** diff `schema` (with FTS) into the directory; returns the file written */
	diff(schema: string, name: string): string
	/** the directory's files in order */
	files(): string[]
	dispose(): void
}

/** A history in `dir`, a fresh directory by default, whose diffs add the FTS groups in `fts` */
export function history(dir: string = mkdtempSync(join(tmpdir(), "comb-rebuild-guard-")), fts = FTS): History {
	const files = () =>
		readdirSync(dir)
			.filter((file) => file.endsWith(".sql"))
			.sort()
			.map((file) => join(dir, file))
	return {
		add(name, sql) {
			writeFileSync(join(dir, name), sql)
			spawnSync("atlas", ["migrate", "hash", "--dir", `file://${dir}`])
		},
		diff(schema, name) {
			const result = generateIncrementalMigration({
				dialect: "sqlite",
				ftsSql: fts,
				migrationName: name,
				migrationsDir: dir,
				targetSchema: schema,
			})
			return result.files[0] as string
		},
		dir,
		dispose: () => rmSync(dir, { force: true, recursive: true }),
		files,
	}
}

const read = (file: string): string => readFileSync(file, "utf8")

/** What one guarded rebuild leaves: the rows before and after, its soundness, and its rating */
export type Outcome = {
	after: Record<string, unknown>
	before: Record<string, unknown>
	safety: string
	sound: Record<string, unknown>
}

/** Diff `schema` into `h` as `name`, apply the file it writes on `engine`, and see what it left */
async function rebuild(
	engine: Engine,
	h: History,
	{ name, schema }: { name: string; schema: string },
): Promise<Outcome> {
	const before = await snapshot(engine)
	const earlier = extractSchema(h.files().map(read).join("\n"))
	const file = h.diff(schema, name)
	await engine.apply(read(file))
	const safety = classifyMigration(read(file), { before: earlier, dialect: "sqlite" }).safety
	return { after: await snapshot(engine), before, safety, sound: await soundness(engine) }
}

/** The whole scenario: the base migration and its rows, then a rebuild of u, then of u and post together */
export async function runScenario(engine: Engine, h: History): Promise<{ both: Outcome; parent: Outcome }> {
	await engine.apply(read(h.diff(BASE, "init")))
	await engine.run(SEED)
	const parent = await rebuild(engine, h, { name: "rebuild_u", schema: REBUILD_U })
	const both = await rebuild(engine, h, { name: "rebuild_both", schema: REBUILD_BOTH })
	return { both, parent }
}

/** What every engine must show for an outcome */
export const SOUND = { foreignKeyCheck: [], keepTables: [] }
