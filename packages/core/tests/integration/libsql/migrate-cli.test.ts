/**
 * `comb migrate apply` and `baseline` as the README documents them, on a real SQLite file: the
 * database and its environment come from comb.migrate.config.ts, a destructive migration needs
 * --yes or a confirmation, and each file is applied and recorded together or not at all.
 */
import { createClient } from "@libsql/client"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { runCli } from "../../../src/cli/index.ts"
import { legacyMigrationHash } from "../../../src/migrate/core/parse.ts"
import { guardRebuilds } from "../../../src/migrate/core/rebuild-guard.ts"
import { extractSchema } from "../../../src/migrate/core/schema.ts"

import { CYCLE_BASE, CYCLE_REBUILD } from "../support/cycle-guard.ts"

const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { force: true, recursive: true })
})

/** A project with comb.migrate.config.ts (a local and a staging environment) and its migrations */
function project(migrations: Record<string, string>) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-migrate-cli-"))
	dirs.push(dir)
	fs.mkdirSync(path.join(dir, "atlas-migrations"))
	for (const [name, sql] of Object.entries(migrations)) fs.writeFileSync(path.join(dir, "atlas-migrations", name), sql)
	spawnSync("atlas", ["migrate", "hash", "--dir", `file://${path.join(dir, "atlas-migrations")}`])
	const url = (file: string) => `file:${path.join(dir, file)}`
	fs.writeFileSync(
		path.join(dir, "comb.migrate.config.ts"),
		`export default { databases: { core: { migrationsDir: "./atlas-migrations", environments: {
	local: { name: "core-local", provider: { type: "libsql", url: ${JSON.stringify(url("local.db"))} } },
	staging: { name: "core-staging", provider: { type: "libsql", url: ${JSON.stringify(url("staging.db"))} } },
} } } }\n`,
	)
	return { dir, url }
}

function io(dir: string, confirm?: (question: string) => Promise<boolean>) {
	const out: string[] = []
	const err: string[] = []
	return {
		confirm,
		cwd: dir,
		err: (line: string) => err.push(line),
		errors: err,
		out: (line: string) => out.push(line),
		outputs: out,
	}
}

/** The database at `url` made, holding one table, `keep`: not an empty target */
async function keep(url: string): Promise<void> {
	const client = createClient({ url })
	await client.execute("CREATE TABLE keep (x)")
	client.close()
}

async function tables(url: string): Promise<string[]> {
	const client = createClient({ url })
	try {
		const { rows } = await client.execute(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' ORDER BY name",
		)
		return rows.map((row) => String(row[0]))
	} finally {
		client.close()
	}
}

describe("migrate apply through comb.migrate.config.ts (A-H4)", () => {
	it("applies the pending migrations to the environment -e names, and skips them the next time", async () => {
		const { dir, url } = project({ "20260101000000_init.sql": "CREATE TABLE post (id TEXT PRIMARY KEY);" })
		const first = io(dir)
		expect(await runCli(["migrate", "apply", "core", "-e", "staging"], first)).toBe(0)
		expect(await tables(url("staging.db"))).toEqual(["__drizzle_migrations", "post"])
		expect(fs.existsSync(path.join(dir, "local.db"))).toBe(false)
		const again = io(dir)
		expect(await runCli(["migrate", "apply", "core", "--env", "staging"], again)).toBe(0)
		expect(again.outputs.join("\n")).toContain("Skip (already applied): 20260101000000_init.sql")
	})

	it("says which environments exist when -e is missing or unknown", async () => {
		const { dir } = project({})
		for (const argv of [
			["migrate", "apply", "core"],
			["migrate", "apply", "core", "-e", "prod"],
		]) {
			const run = io(dir)
			expect(await runCli(argv, run)).toBe(1)
			expect(run.errors.join("\n")).toMatch(/local, staging/)
		}
	})
})

describe("migrate apply through comb.migrate.config.ts (A-H4): destructive and legacy migrations", () => {
	it("refuses a destructive migration without --yes or a confirmation, and applies nothing", async () => {
		const { dir, url } = project({
			"20260101000000_init.sql": "CREATE TABLE post (id TEXT PRIMARY KEY);",
			"20260102000000_drop.sql": "DROP TABLE post;",
		})
		await keep(url("local.db"))
		/* every pending file is approved before any applies, so a refusal leaves even the first unapplied */
		expect(await runCli(["migrate", "apply", "core", "-e", "local"], io(dir))).toBe(1)
		expect(await tables(url("local.db"))).toEqual(["__drizzle_migrations", "keep"])

		const declined = io(dir, async () => false)
		expect(await runCli(["migrate", "apply", "core", "-e", "local"], declined)).toBe(1)
		expect(await tables(url("local.db"))).toEqual(["__drizzle_migrations", "keep"])

		const asked: string[] = []
		const accepted = io(dir, async (question) => (asked.push(question), true))
		expect(await runCli(["migrate", "apply", "core", "-e", "local"], accepted)).toBe(0)
		expect(asked.join("\n")).toContain("DROP TABLE post")
		expect(await tables(url("local.db"))).toEqual(["__drizzle_migrations", "keep"])
	})

	it("applies a cautious migration with --yes without asking, and asks about an unsafe one unless the file approves it", async () => {
		const { dir, url } = project({
			"1_init.sql": "CREATE TABLE post (id TEXT);\nCREATE INDEX idx_post ON post (id);",
			"2_index.sql": "DROP INDEX idx_post;",
			"3_drop.sql": "DROP TABLE post;",
		})
		await keep(url("local.db"))
		const asked: string[] = []
		const declined = io(dir, async (question) => (asked.push(question), false))
		expect(await runCli(["migrate", "apply", "core", "-e", "local", "--yes"], declined)).toBe(1)
		expect(asked).toHaveLength(1)
		expect(asked[0]).toContain("DROP TABLE post")
		expect(declined.errors.join("\n")).toContain("3_drop.sql is unsafe")
		expect(await tables(url("local.db"))).toEqual(["__drizzle_migrations", "keep"])
		fs.writeFileSync(
			path.join(dir, "atlas-migrations", "3_drop.sql"),
			"-- comb:allow-unsafe: post is retired\nDROP TABLE post;",
		)
		spawnSync("atlas", ["migrate", "hash", "--dir", `file://${path.join(dir, "atlas-migrations")}`])
		expect(await runCli(["migrate", "apply", "core", "-e", "local", "--yes"], io(dir))).toBe(0)
		expect(await tables(url("local.db"))).toEqual(["__drizzle_migrations", "keep"])
	})
})

/** A project whose 2_row.sql is recorded, as an earlier comb did, under its pre-0.5.0 hash at `at` */
async function legacyRecorded(at: number) {
	const sql = "INSERT INTO t VALUES ('a -- b\nc');"
	const { dir, url } = project({ "1_t.sql": "CREATE TABLE t (v TEXT);", "2_row.sql": sql })
	expect(await runCli(["migrate", "apply", "core", "-e", "local"], io(dir))).toBe(0)
	const client = createClient({ url: url("local.db") })
	await client.execute("DELETE FROM t")
	await client.execute("DELETE FROM __drizzle_migrations WHERE id = 2")
	await client.execute({
		args: [legacyMigrationHash(sql), at],
		sql: "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
	})
	client.close()
	return dir
}

describe("migrate apply through comb.migrate.config.ts (A-H4): files recorded by an earlier comb", () => {
	it("skips a file recorded under its pre-0.5.0 hash before 0.5.0", async () => {
		const run = io(await legacyRecorded(Date.parse("2026-10-17T12:00:00Z")))
		expect(await runCli(["migrate", "apply", "core", "-e", "local"], run)).toBe(0)
		expect(run.outputs.join("\n")).toContain("Skip (already applied): 2_row.sql")
	})

	/* M44: since 0.5.0 a row holds the current hash, so a match by the legacy one is an edit the old normalizing hides */
	it("refuses a row recorded since 0.5.0 that only the pre-0.5.0 hash matches", async () => {
		const run = io(await legacyRecorded(Date.parse("2026-10-20T12:00:00Z")))
		expect(await runCli(["migrate", "apply", "core", "-e", "local"], run)).toBe(1)
		expect(run.errors.join("\n")).toContain("1 applied migration matches no file")
	})
})

/* a table with an FTS5 index over it, as comb's fts generator writes one */
const WITH_FTS = {
	"1_init.sql": "CREATE TABLE post (id TEXT PRIMARY KEY, title TEXT);",
	"2_fts.sql":
		"CREATE VIRTUAL TABLE post_fts USING fts5(title, content='post');\nCREATE TRIGGER post_fts_ai AFTER INSERT ON post BEGIN INSERT INTO post_fts(rowid, title) VALUES (new.rowid, new.title); END;",
}

describe("migrate baseline", () => {
	it("records each migration once the database's schema is the one they leave, FTS index and all", async () => {
		const { dir, url } = project(WITH_FTS)
		expect(await runCli(["migrate", "apply", "core", "-e", "local"], io(dir))).toBe(0)
		const client = createClient({ url: url("local.db") })
		await client.execute("DELETE FROM __drizzle_migrations")
		client.close()
		const run = io(dir)
		expect(await runCli(["migrate", "baseline", "core", "-e", "local"], run), run.errors.join("\n")).toBe(0)
		expect(run.outputs).toEqual([
			"Marked applied: 1_init.sql",
			"Marked applied: 2_fts.sql",
			"\nBaseline done: 2 marked, 0 already tracked",
		])
	})

	it("records nothing on a database whose schema is not the one the migrations leave, and says how", async () => {
		const { dir, url } = project(WITH_FTS)
		const client = createClient({ url: url("local.db") })
		await client.execute("CREATE TABLE post (id TEXT PRIMARY KEY)")
		client.close()
		const run = io(dir)
		expect(await runCli(["migrate", "baseline", "core", "-e", "local"], run)).toBe(1)
		expect(run.errors[0]).toContain("'s schema is not the one its migrations leave, so baseline records nothing")
		expect(run.errors[0]).toContain("ADD COLUMN `title` text NULL")
		expect(run.errors[0]).toContain("-- FTS table post_fts: only in the migrations")
		expect(await tables(url("local.db"))).toEqual(["__drizzle_migrations", "post"])
	})
})

describe("migrate options", () => {
	it("refuses an option it does not know, and one that is missing its value", async () => {
		const { dir } = project({})
		const unknown = io(dir)
		expect(await runCli(["migrate", "apply", "core", "--nope"], unknown)).toBe(1)
		expect(unknown.errors.join("\n")).toContain("Unknown option: --nope")
		const bare = io(dir)
		expect(await runCli(["migrate", "apply", "core", "-e"], bare)).toBe(1)
		expect(bare.errors.join("\n")).toContain("-e needs a value")
	})
})

describe("migrate apply refuses a rebuild outside the file's transaction", () => {
	it("refuses a guarded rebuild in an atlas:txmode none file even with --yes, and keeps every row", async () => {
		const { dir, url } = project({ "20260101000000_init.sql": CYCLE_BASE })
		expect(await runCli(["migrate", "apply", "core", "-e", "local"], io(dir))).toBe(0)
		const client = createClient({ url: url("local.db") })
		await client.executeMultiple(
			"INSERT INTO parent VALUES (1, 'p'); INSERT INTO a VALUES (1, 1, NULL, 'a'); INSERT INTO b VALUES (1, 1, 'b'); UPDATE a SET b_id = 1;",
		)
		const guarded = guardRebuilds(CYCLE_REBUILD, extractSchema(CYCLE_BASE))
		fs.writeFileSync(
			path.join(dir, "atlas-migrations", "20260102000000_rebuild.sql"),
			`-- atlas:txmode none\n${guarded}`,
		)
		spawnSync("atlas", ["migrate", "hash", "--dir", `file://${path.join(dir, "atlas-migrations")}`])
		const run = io(dir)
		expect(await runCli(["migrate", "apply", "core", "-e", "local", "--yes"], run)).toBe(1)
		expect(run.errors.join("\n")).toContain("a rebuild needs the file's transaction")
		const count = async (table: string) =>
			Number((await client.execute(`SELECT count(*) AS n FROM ${table}`)).rows[0]?.n)
		expect([await count("parent"), await count("a"), await count("b")]).toEqual([1, 1, 1])
		client.close()
	}, 60_000)
})

describe("migrate apply runs each file as written (M12)", () => {
	it("applies an index as the file writes it: a different index of that name fails the apply (M12)", async () => {
		const { dir, url } = project({
			"20260101000000_init.sql": "CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT);",
			"20260102000000_idx.sql": "CREATE UNIQUE INDEX idx_email ON users (email);",
		})
		expect(
			await runCli(
				["migrate", "apply", "core", "-e", "local", "--file", "atlas-migrations/20260101000000_init.sql"],
				io(dir),
			),
		).toBe(0)
		const client = createClient({ url: url("local.db") })
		await client.execute("CREATE INDEX idx_email ON users (id)")
		const apply = io(dir)
		expect(await runCli(["migrate", "apply", "core", "-e", "local"], apply)).toBe(1)
		expect(apply.errors.join("\n")).toMatch(/idx_email already exists/)
		client.close()
	})
})

describe("migrate apply on an empty target (C3)", () => {
	it("applies a history with an unsafe file to an empty target without the gate, saying so; a target with a table still refuses (C3)", async () => {
		const history = {
			"20260101000000_init.sql": "CREATE TABLE post (id TEXT PRIMARY KEY);",
			"20260102000000_drop.sql": "DROP TABLE post;\nCREATE TABLE note (id TEXT PRIMARY KEY);",
		}
		const fresh = project(history)
		const run = io(fresh.dir)
		expect(await runCli(["migrate", "apply", "core", "-e", "local"], run)).toBe(0)
		expect(run.outputs[0]).toBe(
			"Empty target: no tables and no applied history, so nothing can be lost; 2 files apply without the unsafe gate",
		)
		expect(await tables(fresh.url("local.db"))).toEqual(["__drizzle_migrations", "note"])
		const used = project(history)
		await keep(used.url("local.db"))
		const refused = io(used.dir)
		expect(await runCli(["migrate", "apply", "core", "-e", "local"], refused)).toBe(1)
		expect(refused.errors.join("\n")).toContain("20260102000000_drop.sql is unsafe")
	})
})

describe("migrate apply and check --json on libsql (C5)", () => {
	it("prints one JSON object as the only stdout, the human lines on stderr", async () => {
		const { dir, url } = project({ "20260101000000_init.sql": "CREATE TABLE post (id TEXT PRIMARY KEY);" })
		createClient({ url: url("local.db") }).close()
		const check = io(dir)
		expect(await runCli(["migrate", "check", "core", "-e", "local", "--json"], check)).toBe(0)
		expect(check.outputs.map((line) => JSON.parse(line) as unknown)).toEqual([
			{ applied: [], database: "core", pending: ["20260101000000_init.sql"], refused: [] },
		])
		const apply = io(dir)
		expect(await runCli(["migrate", "apply", "core", "-e", "local", "--json"], apply)).toBe(0)
		expect(apply.outputs.map((line) => JSON.parse(line) as unknown)).toEqual([
			{ applied: ["20260101000000_init.sql"], database: "core", pending: [], refused: [] },
		])
		expect(apply.errors).toContain("Apply: 20260101000000_init.sql")
	})

	it("reports the pending files with a refusal, the refused one among them (M16)", async () => {
		const { dir, url } = project({
			"20260101000000_init.sql": "CREATE TABLE users (id TEXT PRIMARY KEY);",
			"20260102000000_drop.sql": "DROP TABLE users;",
		})
		await keep(url("local.db"))
		const check = io(dir)
		expect(await runCli(["migrate", "check", "core", "-e", "local", "--yes", "--json"], check)).toBe(1)
		const [report] = check.outputs.map((line) => JSON.parse(line) as { pending: string[]; refused: string[] })
		expect(report?.pending).toEqual(["20260101000000_init.sql", "20260102000000_drop.sql"])
		expect(report?.refused[0]).toMatch(/^20260102000000_drop\.sql is unsafe/)
	})

	it("reports a config that throws a string as that string in refused", async () => {
		const { dir } = project({ "20260101000000_init.sql": "CREATE TABLE post (id TEXT PRIMARY KEY);" })
		fs.writeFileSync(path.join(dir, "comb.migrate.config.ts"), `throw "plain string from config"\n`)
		const status = io(dir)
		expect(await runCli(["migrate", "status", "core", "--json"], status)).toBe(1)
		expect(status.outputs.map((line) => JSON.parse(line) as unknown)).toEqual([
			{ applied: [], database: "core", pending: [], refused: ["plain string from config"] },
		])
	})
})

/** A database file beside the project holding two users, and its rows read back */
async function victim(dir: string): Promise<{ ids: () => Promise<unknown[]>; path: string }> {
	const file = path.join(dir, "live.db")
	const client = createClient({ url: `file:${file}` })
	await client.executeMultiple(
		"CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT); INSERT INTO users VALUES (1, 'a@x.io'), (2, 'b@x.io');",
	)
	client.close()
	return {
		ids: async () => {
			const read = createClient({ url: `file:${file}` })
			try {
				return (await read.execute("SELECT id FROM users ORDER BY id")).rows.map((row) => row[0])
			} finally {
				read.close()
			}
		},
		path: file,
	}
}

/** A pending file that attaches the database at `file` and deletes its users, under `approval` */
const attach = (file: string, approval = "") => `${approval}ATTACH '${file}' AS live;\nDELETE FROM live.users;`

/*
 * M40: a pending file that attaches another database. check proves it on a copy, apply proves it
 * before it runs, and an empty target applies without the gate, so each must refuse it before
 * anything runs it: the attached database keeps its rows, whatever the file approves.
 */
describe("migrate never runs a file that reaches outside its database (M40)", () => {
	it("refuses it in check, apply --yes and an approved file, and the attached database keeps its rows", async () => {
		const { dir, url } = project({ "20260101000000_init.sql": "CREATE TABLE post (id TEXT PRIMARY KEY);" })
		const live = await victim(dir)
		expect(await runCli(["migrate", "apply", "core", "-e", "local"], io(dir))).toBe(0)
		for (const [file, args] of [
			[attach(live.path), ["check", "core", "-e", "local"]],
			[attach(live.path), ["apply", "core", "-e", "local", "--yes"]],
			[attach(live.path, "-- comb:allow-unsafe: reads the old store\n"), ["apply", "core", "-e", "local", "--yes"]],
		] as const) {
			fs.writeFileSync(path.join(dir, "atlas-migrations", "20260102000000_attach.sql"), file)
			spawnSync("atlas", ["migrate", "hash", "--dir", `file://${path.join(dir, "atlas-migrations")}`])
			const run = io(dir)
			expect(await runCli(["migrate", ...args], run)).toBe(1)
			expect(run.errors.join("\n")).toContain("comb never runs ATTACH in a migration")
			expect(await live.ids()).toEqual([1, 2])
		}
		expect(await tables(url("local.db"))).toEqual(["__drizzle_migrations", "post"])
	})

	it("refuses it on an empty target too, where the unsafe gate does not apply", async () => {
		const { dir, url } = project({})
		const live = await victim(dir)
		fs.writeFileSync(path.join(dir, "atlas-migrations", "20260101000000_attach.sql"), attach(live.path))
		spawnSync("atlas", ["migrate", "hash", "--dir", `file://${path.join(dir, "atlas-migrations")}`])
		const run = io(dir)
		expect(await runCli(["migrate", "apply", "core", "-e", "local"], run)).toBe(1)
		expect(run.errors.join("\n")).toContain("comb never runs ATTACH in a migration")
		expect(await live.ids()).toEqual([1, 2])
		expect(fs.existsSync(url("local.db").slice("file:".length)) ? await tables(url("local.db")) : []).not.toContain(
			"users",
		)
	})
})

/* M41: a REPLACE backfill of a column the file added deletes the rows its value meets; --yes covers
   only cautious files, so it must not be one */
describe("migrate apply --yes on a REPLACE backfill (M41)", () => {
	it("refuses it as unsafe, and every user stays", async () => {
		const { dir, url } = project({
			"20260101000000_init.sql": "CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT);",
		})
		expect(await runCli(["migrate", "apply", "core", "-e", "local"], io(dir))).toBe(0)
		const client = createClient({ url: url("local.db") })
		await client.execute("INSERT INTO users VALUES (1, 'a@x.io'), (2, 'b@x.io'), (3, 'c@y.io')")
		fs.writeFileSync(
			path.join(dir, "atlas-migrations", "20260102000000_tag.sql"),
			"ALTER TABLE users ADD COLUMN tag TEXT;\nCREATE UNIQUE INDEX users_tag ON users (tag);\nUPDATE OR REPLACE users SET tag = 'x' WHERE email LIKE '%@x.io';",
		)
		spawnSync("atlas", ["migrate", "hash", "--dir", `file://${path.join(dir, "atlas-migrations")}`])
		const run = io(dir)
		expect(await runCli(["migrate", "apply", "core", "-e", "local", "--yes"], run)).toBe(1)
		expect(run.errors.join("\n")).toContain("replaces the rows it conflicts with")
		expect((await client.execute("SELECT id FROM users ORDER BY id")).rows.map((row) => row[0])).toEqual([1, 2, 3])
		client.close()
	})
})

/* M42: a contentless FTS5 table holds the only copy of its index, so a 'delete-all' spelled with a
   conflict clause must be refused like the plain one */
describe("migrate apply --yes on an FTS5 'delete-all' with a conflict clause (M42)", () => {
	it("refuses it as unsafe, and the index keeps its entries", async () => {
		const { dir, url } = project({
			"20260101000000_init.sql": "CREATE VIRTUAL TABLE cl USING fts5(body, content='');",
		})
		expect(await runCli(["migrate", "apply", "core", "-e", "local"], io(dir))).toBe(0)
		const client = createClient({ url: url("local.db") })
		await client.execute("INSERT INTO cl(rowid, body) VALUES (1, 'alpha one'), (2, 'alpha two')")
		const hits = async () =>
			(await client.execute("SELECT rowid FROM cl WHERE cl MATCH 'alpha' ORDER BY rowid")).rows.map((row) => row[0])
		fs.writeFileSync(
			path.join(dir, "atlas-migrations", "20260102000000_wipe.sql"),
			"INSERT OR ABORT INTO cl(cl) VALUES ('delete-all');",
		)
		spawnSync("atlas", ["migrate", "hash", "--dir", `file://${path.join(dir, "atlas-migrations")}`])
		const run = io(dir)
		expect(await runCli(["migrate", "apply", "core", "-e", "local", "--yes"], run)).toBe(1)
		expect(run.errors.join("\n")).toContain("FTS5 command")
		expect(await hits()).toEqual([1, 2])
		client.close()
	})
})

/* M43: a history trigger that runs 'delete-all' wipes the index on every insert it fires on, so
   --yes must refuse a plain insert into its table */
describe("migrate apply --yes on an insert that fires a trigger running an FTS5 command (M43)", () => {
	it("refuses it as unsafe, and the index keeps its entries", async () => {
		const { dir, url } = project({
			"20260101000000_init.sql": `CREATE TABLE post (id INTEGER PRIMARY KEY, title TEXT);
CREATE VIRTUAL TABLE post_fts USING fts5(title, content='post', content_rowid='id');
CREATE TRIGGER post_ai AFTER INSERT ON post BEGIN INSERT INTO post_fts(post_fts) VALUES ('delete-all'); INSERT INTO post_fts(rowid, title) VALUES (new.id, new.title); END;`,
		})
		expect(await runCli(["migrate", "apply", "core", "-e", "local"], io(dir))).toBe(0)
		const client = createClient({ url: url("local.db") })
		await client.execute("INSERT INTO post_fts(rowid, title) VALUES (1, 'alpha one'), (2, 'alpha two')")
		const hits = async () =>
			(await client.execute("SELECT rowid FROM post_fts WHERE post_fts MATCH 'alpha' ORDER BY rowid")).rows.map(
				(row) => row[0],
			)
		fs.writeFileSync(
			path.join(dir, "atlas-migrations", "20260102000000_seed.sql"),
			"INSERT INTO post (id, title) VALUES (10, 'fresh');",
		)
		spawnSync("atlas", ["migrate", "hash", "--dir", `file://${path.join(dir, "atlas-migrations")}`])
		const run = io(dir)
		expect(await runCli(["migrate", "apply", "core", "-e", "local", "--yes"], run)).toBe(1)
		expect(run.errors.join("\n")).toContain("fires trigger post_ai")
		expect(await hits()).toEqual([1, 2])
		client.close()
	})
})
