import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { wranglerBin } from "../../cli/__fixtures__/d1.ts"
import { libsqlConnection } from "../__fixtures__/libsql-connection.ts"
import { scopeCorpus } from "../__fixtures__/scope-corpus.ts"
import { main, prove } from "./d1-engine-child.mjs"
import { proofInput } from "./d1-engine.ts"
import { notEngineTables } from "./engine-tables.ts"
import { creatable, jsonColumns, liveObjects, scriptOf } from "./proof-copy.ts"

vi.mock("bun:sqlite", () => import("../__fixtures__/bun-sqlite-node.ts"))

const LIVE = "CREATE TABLE t (id INTEGER PRIMARY KEY, v REAL NOT NULL DEFAULT 1);\nINSERT INTO t (v) VALUES (2), (3);"

const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

/** `files` proven in this process on the checked wrangler's D1, over a live database `schema` made (t by default) */
async function proven(
	files: Array<{ name: string; sql: string }>,
	{ schema = LIVE, table = "d1_migrations" }: { schema?: string; table?: string } = {},
): Promise<string | undefined> {
	const live = libsqlConnection()
	const dir = mkdtempSync(join(tmpdir(), "comb-d1-child-"))
	dirs.push(dir)
	try {
		await live.client.executeMultiple(schema)
		const objects = creatable(await liveObjects(live, notEngineTables(live)))
		return (await prove(await proofInput(objects, files, { bin: wranglerBin(), dir, table }))).refused
	} finally {
		await live.close()
	}
}

/** D1's answer to `file` over a live database `schema` made, on the scoped copy and on the whole schema's copy */
async function d1Verdicts(schema: string, sql: string): Promise<{ scoped: string; whole: string }> {
	const live = libsqlConnection()
	const dir = mkdtempSync(join(tmpdir(), "comb-d1-child-"))
	dirs.push(dir)
	try {
		await live.client.executeMultiple(schema)
		const objects = creatable(await liveObjects(live, notEngineTables(live)))
		const files = [{ name: "1_case.sql", sql }]
		const input = await proofInput(objects, files, { bin: wranglerBin(), dir, table: "d1_migrations" })
		const whole = [...(await scriptOf(objects, { json: jsonColumns(files), variant: 0 })), input.seed.at(-1) as string]
		const answer = async (seed: string[]): Promise<string> => (await prove({ ...input, seed })).refused ?? "passes"
		return { scoped: await answer(input.seed), whole: await answer(whole) }
	} finally {
		await live.close()
	}
}

/* 8.5 of plan 21: the scoped copy's equal verdict holds on D1's own engine too, not only on the bun:sqlite proof's */
describe("prove answers every corpus file on the scoped copy as on the whole schema's copy (8.5)", () => {
	it.each(scopeCorpus().map((each) => [each.label, each] as const))(
		"%s",
		async (_, { file, schema }) => {
			const { scoped, whole } = await d1Verdicts(schema, file)
			expect(scoped).toBe(whole)
		},
		120_000,
	)
})

describe("prove: what wrangler's own split refuses", () => {
	/* the history row wrangler appends holds the file's name, which refuseRewritten does not read: wrangler's own
	   trimSqlQuery refuses the batch, an error with no cause, as its apply would */
	it("refuses a file whose name holds the words wrangler trims, in wrangler's words", async () => {
		const refused = await proven([{ name: "2_BEGIN TRANSACTION.sql", sql: "CREATE TABLE a (x);" }])
		expect(refused).toMatch(
			/^2_BEGIN TRANSACTION\.sql: D1 refuses this file on its own engine, as wrangler's apply would: Wrangler could not process the provided SQL file, as it contains several transactions/,
		)
	}, 120_000)
})

describe("prove: each file on D1's own engine (SD1 of r22)", () => {
	it("passes files D1 runs, its history row appended to a table of any name", async () => {
		const files = [
			{ name: "1_box.sql", sql: "CREATE VIRTUAL TABLE box USING rtree (id, x0, x1);" },
			{ name: "2_o'pt.sql", sql: "CREATE INDEX t_v ON t (v);\nPRAGMA optimize(65538);" },
			{ name: "3_tr.sql", sql: "CREATE TRIGGER t_up AFTER UPDATE OF v ON t BEGIN SELECT abs(new.v); END;" },
		]
		expect(await proven(files, { table: 'my "history"' })).toBeUndefined()
	}, 120_000)

	it("refuses a file D1 refuses as it runs, naming D1's error", async () => {
		const refused = await proven([
			{ name: "1_ok.sql", sql: "CREATE TABLE a (x);" },
			{ name: "2_sq.sql", sql: "ALTER TABLE t ADD COLUMN sq REAL;\nUPDATE t SET sq = power(v, 2);" },
		])
		expect(refused).toMatch(
			/^2_sq\.sql: D1 refuses this file on its own engine, as wrangler's apply would: .*not authorized to use function: power/,
		)
	}, 120_000)

	it("refuses a generated column D1 refuses as it creates it", async () => {
		const refused = await proven([
			{
				name: "1_g.sql",
				sql: "CREATE TABLE g (id INTEGER PRIMARY KEY, v REAL, up REAL GENERATED ALWAYS AS (ceiling(v)) VIRTUAL);",
			},
		])
		expect(refused).toMatch(
			/^1_g\.sql: D1 refuses this file on its own engine, .*not authorized to use function: ceiling/,
		)
	}, 120_000)
})

/* SD1 of r22: D1 resolves a function in a trigger, a view or a generated column only when a statement runs it */
describe("prove: what D1 applies and then cannot run", () => {
	it.each([
		[
			"a trigger body",
			"CREATE TABLE sq (id INTEGER PRIMARY KEY, v REAL);\nCREATE TRIGGER t_sq AFTER INSERT ON t BEGIN INSERT INTO sq (id, v) VALUES (new.id, power(new.v, 2)); END;",
			/then refuses INSERT INTO "t" DEFAULT VALUES: .*not authorized to use function: power/,
		],
		[
			"an UPDATE trigger's body",
			"CREATE TRIGGER t_up AFTER UPDATE ON t BEGIN SELECT power(new.v, 2); END;",
			/then refuses UPDATE "t" SET "id" = "id", "v" = "v": .*not authorized to use function: power/,
		],
		[
			"a DELETE trigger's body",
			"CREATE TRIGGER t_del AFTER DELETE ON t BEGIN SELECT power(old.v, 2); END;",
			/then refuses DELETE FROM "t": .*not authorized to use function: power/,
		],
		[
			"a view",
			"CREATE VIEW stats AS SELECT median(v) AS med FROM t;",
			/then refuses SELECT \* FROM "stats": .*no such function: median/,
		],
	])(
		"refuses %s D1 applies and then cannot run, naming the statement and D1's error",
		async (_, sql, error) => {
			const refused = await proven([{ name: "1_late.sql", sql }])
			expect(refused).toMatch(/^1_late\.sql: D1 applies this file, then refuses /)
			expect(refused).toMatch(error)
		},
		120_000,
	)
})

describe("prove over a schema with foreign keys, which D1 always enforces", () => {
	it.each([
		[
			"a child table made before its parent",
			"CREATE TABLE child (id INTEGER PRIMARY KEY, p INTEGER NOT NULL REFERENCES parent (id));\nCREATE TABLE parent (id INTEGER PRIMARY KEY);",
		],
		[
			"a parent comb cannot seed, whose child's key cannot be empty",
			"CREATE TABLE parent (id INTEGER PRIMARY KEY, c TEXT NOT NULL CHECK (c = 'x' AND c = 'y'));\nCREATE TABLE child (id INTEGER PRIMARY KEY, p INTEGER NOT NULL REFERENCES parent (id));",
		],
	])(
		"passes a plain file over %s, whose foreign keys D1 always enforces (8.5)",
		async (_, schema) => {
			expect(
				await proven([{ name: "1_probe.sql", sql: "CREATE TABLE probe (id INTEGER PRIMARY KEY);" }], { schema }),
			).toBeUndefined()
		},
		120_000,
	)

	it("passes a file over a self-reference whose rows sort before the row each points at", async () => {
		const schema = "CREATE TABLE node (id TEXT PRIMARY KEY, up TEXT REFERENCES node (id), n INTEGER) WITHOUT ROWID;"
		expect(
			await proven([{ name: "1_probe.sql", sql: "CREATE TABLE probe (id INTEGER PRIMARY KEY);" }], { schema }),
		).toBeUndefined()
	}, 120_000)

	it.each([
		[
			"a parent its child references, the child made first",
			"CREATE TABLE child (id INTEGER PRIMARY KEY, p INTEGER NOT NULL REFERENCES parent (id));\nCREATE TABLE parent (id INTEGER PRIMARY KEY);",
			"DROP TABLE parent;",
		],
		[
			"a table of a two-table cycle whose keys may not be NULL",
			"CREATE TABLE a (id INTEGER PRIMARY KEY, b INTEGER NOT NULL REFERENCES b (id));\nCREATE TABLE b (id INTEGER PRIMARY KEY, a INTEGER NOT NULL REFERENCES a (id));",
			"DROP TABLE a;",
		],
	])(
		"refuses a pending DROP of %s, as D1 refuses it with its rows",
		async (_, schema, sql) => {
			expect(await proven([{ name: "1_drop.sql", sql }], { schema })).toMatch(
				/^1_drop\.sql: D1 refuses this file on its own engine, as wrangler's apply would: .*FOREIGN KEY constraint failed/,
			)
		},
		120_000,
	)
})

/* AC2-3 of area C round 2: reading the scratch D1's shadow tables through pragma_table_list opens every table,
   which runs workerd's SQLite out of memory near 3 000 tables */
describe("prove over a database of 3 000 tables", () => {
	it("answers a pending ALTER TABLE", async () => {
		const dir = mkdtempSync(join(tmpdir(), "comb-d1-child-"))
		dirs.push(dir)
		const files = [{ name: "1_add.sql", sql: "ALTER TABLE t0 ADD COLUMN c TEXT;" }]
		const input = await proofInput([], files, { bin: wranglerBin(), dir, table: "d1_migrations" })
		const tables = Array.from(
			{ length: 3000 },
			(_, i) => `CREATE TABLE t${i} (id INTEGER PRIMARY KEY, a TEXT, b INTEGER)`,
		)
		expect(await prove({ ...input, seed: [...tables, ...input.seed] })).toEqual({})
	}, 120_000)
})

describe("main: the proof of the input JSON d1-engine.ts writes", () => {
	it("reads the input from its file and answers as prove does", async () => {
		const dir = mkdtempSync(join(tmpdir(), "comb-d1-child-"))
		dirs.push(dir)
		const input = await proofInput([], [{ name: "1_a.sql", sql: "CREATE TABLE a (x);" }], {
			bin: wranglerBin(),
			dir,
			table: "d1_migrations",
		})
		writeFileSync(join(dir, "input.json"), JSON.stringify(input))
		expect(await main(join(dir, "input.json"))).toEqual({})
	}, 120_000)
})
