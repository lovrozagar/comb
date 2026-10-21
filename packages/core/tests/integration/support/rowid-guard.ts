/**
 * The rowid scenario: Atlas rebuilds a text-keyed table four tables reference, one keyed by an
 * INTEGER PRIMARY KEY at 100 columns, and then a 100-column table nothing references. Every row
 * survives, and every rowid with it except where a table has 100 columns and no key that is its
 * rowid, as D1 caps a SELECT at 100 result columns. One scenario, run on each engine.
 */
import { readFileSync } from "node:fs"
import { classifyMigration } from "../../../src/migrate/core/classify.ts"
import { extractSchema } from "../../../src/migrate/core/schema.ts"
import type { Engine, History } from "./rebuild-guard.ts"

/** `n` text columns, `c1` on, `c1` made NOT NULL when `strict` */
const columns = (n: number, strict = false): string =>
	Array.from({ length: n }, (_, i) => `\`c${i + 1}\` text${strict && i === 0 ? " NOT NULL DEFAULT ''" : ""}`).join(", ")

const ref = "`t` text REFERENCES `t`(`id`) ON DELETE CASCADE"

/* t, text-keyed, and its children: k narrow, ki keyed by its rowid at 100 columns, k99 and k100 text-keyed at 99 and 100; w100 apart */
const schema = (
	strictT: boolean,
	strictW: boolean,
): string => `CREATE TABLE \`t\` (\`id\` text PRIMARY KEY, ${columns(1, strictT)});
CREATE TABLE \`k\` (\`id\` text PRIMARY KEY, ${ref}, ${columns(1)});
CREATE TABLE \`ki\` (\`id\` integer PRIMARY KEY, ${ref}, ${columns(98)});
CREATE TABLE \`k99\` (\`id\` text PRIMARY KEY, ${ref}, ${columns(97)});
CREATE TABLE \`k100\` (\`id\` text PRIMARY KEY, ${ref}, ${columns(98)});
CREATE TABLE \`w100\` (\`id\` text PRIMARY KEY, ${columns(99, strictW)});
`

const ROWS = ["a", "b", "c", "d", "e"]

/* rows with gaps in every rowid sequence: b and d deleted after the insert */
const SEED = [
	`INSERT INTO t (id, c1) VALUES ${ROWS.map((id) => `('${id}', 'x${id}')`).join(", ")};`,
	`INSERT INTO k (id, t, c1) VALUES ${ROWS.map((id) => `('k${id}', '${id}', 'y${id}')`).join(", ")};`,
	`INSERT INTO ki (id, t, c98) VALUES ${ROWS.map((id, i) => `(${(i + 1) * 7}, '${id}', 'z${id}')`).join(", ")};`,
	...["k99", "k100"].map(
		(table) =>
			`INSERT INTO ${table} (id, t, c1) VALUES ${ROWS.map((id) => `('${table}${id}', '${id}', 'v${id}')`).join(", ")};`,
	),
	`INSERT INTO w100 (id, c1, c99) VALUES ${ROWS.map((id) => `('w${id}', 'p${id}', 'q${id}')`).join(", ")};`,
	"DELETE FROM t WHERE id IN ('b', 'd');",
	"DELETE FROM w100 WHERE id IN ('wb', 'wd');",
].join("\n")

/** The tables whose rowids must survive, and every table's rows */
async function snapshot(engine: Engine): Promise<Record<string, unknown>> {
	const out: Record<string, unknown> = {}
	for (const table of ["t", "k", "ki", "k99"])
		out[`${table} rowids`] = await engine.rows(`SELECT rowid AS _rowid, id FROM ${table} ORDER BY 1`)
	for (const table of ["t", "k", "ki", "k99", "k100", "w100"])
		out[table] = await engine.rows(`SELECT * FROM ${table} ORDER BY id`)
	return out
}

/** What one rebuild leaves: the snapshot before and after, the file's notes, and what must hold */
export type RowidOutcome = {
	after: Record<string, unknown>
	before: Record<string, unknown>
	notes: string[]
	sound: Record<string, unknown>
}

async function step(
	engine: Engine,
	h: History,
	{ name, target }: { name: string; target: string },
): Promise<RowidOutcome> {
	const before = await snapshot(engine)
	const earlier = extractSchema(
		h
			.files()
			.map((file) => readFileSync(file, "utf8"))
			.join("\n"),
	)
	const file = readFileSync(h.diff(target, name), "utf8")
	await engine.apply(file)
	const sound = {
		foreignKeyCheck: await engine.rows("PRAGMA foreign_key_check"),
		keepTables: await engine.rows("SELECT name FROM sqlite_master WHERE name LIKE '\\_comb\\_keep\\_%' ESCAPE '\\'"),
	}
	const notes = classifyMigration(file, { before: earlier, dialect: "sqlite" }).cautiousStatements
	return { after: await snapshot(engine), before, notes, sound }
}

/** The scenario on `engine` over `h` (made with no FTS): the base and its rows, a rebuild of t, then of w100 */
export async function runRowidScenario(engine: Engine, h: History): Promise<{ t: RowidOutcome; w100: RowidOutcome }> {
	await engine.apply(readFileSync(h.diff(schema(false, false), "init"), "utf8"))
	await engine.run(SEED)
	const t = await step(engine, h, { name: "rebuild_t", target: schema(true, false) })
	const w100 = await step(engine, h, { name: "rebuild_w100", target: schema(true, true) })
	return { t, w100 }
}

/** The notes each rebuild must carry */
export const ROWID_NOTES = {
	t: [
		"DROP TABLE `t` (rebuilds t; comb keeps the rows of k, ki, k99, k100; k100 gets new rowids (100 columns, no INTEGER PRIMARY KEY))",
	],
	w100: [
		"DROP TABLE `w100` (rebuilds w100, copying every column; w100 gets new rowids (100 columns, no INTEGER PRIMARY KEY))",
	],
}
