/**
 * Every index Postgres 17 makes, under the name it gives it (PA12 of r22b). Each history of
 * INDEX_CASES runs on a scratch database, and its catalog, rendered as pg-indexes.test.ts renders
 * comb's facts, must equal the case's list. Then each statement Postgres refuses inside a
 * transaction block for a partitioned table or index (REINDEX, CLUSTER) runs after its history in
 * one, and comb must refuse it exactly when Postgres does, and rate a partitioned index's move to
 * another tablespace, which has no storage to rewrite, without the rewrite's warning.
 */
import pg from "pg"
import { beforeAll, describe, expect, it } from "vitest"
import { classifyMigration } from "../../../src/migrate/core/classify.ts"
import { loadPostgresParser } from "../../../src/migrate/core/pg-parser.ts"
import { extractSchema } from "../../../src/migrate/core/schema.ts"
import { INDEX_CASES } from "../../support/pg-index-cases.ts"
import { withScratchDb } from "../support/pg.ts"

beforeAll(loadPostgresParser)

/* each index's key, its table's, whether it is partitioned and whether a constraint owns it */
const CATALOG = `SELECT n.nspname AS ns, i.relname AS idx, i.relkind, tn.nspname AS tns, t.relname AS tbl,
  EXISTS (SELECT 1 FROM pg_constraint WHERE conindid = i.oid AND contype IN ('p', 'u', 'x')) AS con
FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_class t ON t.oid = x.indrelid
JOIN pg_namespace n ON n.oid = i.relnamespace JOIN pg_namespace tn ON tn.oid = t.relnamespace
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')`

type Row = { con: boolean; idx: string; ns: string; relkind: string; tbl: string; tns: string }

const key = (ns: string, name: string): string => (ns === "public" ? name : `${ns}.${name}`)

/** `run` on one session of a scratch database `history` has run on */
function afterHistory<T>(history: string, run: (client: pg.Client) => Promise<T>): Promise<T> {
	return withScratchDb(async (url) => {
		const client = new pg.Client({ connectionString: url })
		await client.connect()
		try {
			await client.query(history)
			return await run(client)
		} finally {
			await client.end()
		}
	})
}

describe("index names against Postgres 17", () => {
	it.each(INDEX_CASES)("Postgres names $label as the case says", async ({ history, indexes }) => {
		const rows = await afterHistory(history, async (client) => (await client.query<Row>(CATALOG)).rows)
		const rendered = rows.map(
			(row) =>
				`${key(row.ns, row.idx)} on ${key(row.tns, row.tbl)}${row.relkind === "I" ? " partitioned" : ""}${row.con ? " constraint" : ""}`,
		)
		expect(rendered.toSorted()).toEqual(indexes)
	})
})

const P = [
	"CREATE TABLE p (id int NOT NULL, at date NOT NULL) PARTITION BY RANGE (at);",
	"CREATE TABLE p1 PARTITION OF p FOR VALUES FROM ('2020-01-01') TO ('2021-01-01');",
	"",
].join("\n")

// lookup-table: r22b's partitioned-facts repro, each history and the statement run after it in a transaction block
const REFUSALS: ReadonlyArray<readonly [string, string, string]> = [
	["a named index on p", `${P}CREATE INDEX p_at ON p (at);`, "REINDEX INDEX p_at"],
	["an unnamed index on p", `${P}CREATE INDEX ON p (at);`, "REINDEX INDEX p_at_idx"],
	["p's primary key", `${P}ALTER TABLE p ADD PRIMARY KEY (id, at);`, "REINDEX INDEX p_pkey"],
	[
		"p's inline primary key",
		"CREATE TABLE p (id int, at date, PRIMARY KEY (id, at)) PARTITION BY RANGE (at);",
		"REINDEX INDEX p_pkey",
	],
	["p's unnamed unique constraint", `${P}ALTER TABLE p ADD UNIQUE (id, at);`, "REINDEX INDEX p_id_at_key"],
	["p's named unique constraint", `${P}ALTER TABLE p ADD CONSTRAINT p_u UNIQUE (id, at);`, "REINDEX INDEX p_u"],
	["p clustered on its primary key", `${P}ALTER TABLE p ADD PRIMARY KEY (id, at);`, "CLUSTER p USING p_pkey"],
	[
		"a partition partitioned in turn",
		P.replace("('2021-01-01');", "('2021-01-01') PARTITION BY LIST (id);"),
		"REINDEX TABLE p1",
	],
	["a plain partition", P, "REINDEX TABLE p1"],
	["an index renamed", `${P}CREATE INDEX p_at ON p (at);\nALTER INDEX p_at RENAME TO p_when;`, "REINDEX INDEX p_when"],
	["a table renamed", `${P}ALTER TABLE p RENAME TO q;`, "REINDEX TABLE q"],
	["a plain table made where p was dropped", `${P}DROP TABLE p;\nCREATE TABLE p (id int);`, "REINDEX TABLE p"],
	[
		"a plain table made where p was renamed away",
		`${P}ALTER TABLE p RENAME TO q;\nCREATE TABLE p (id int);`,
		"REINDEX TABLE p",
	],
	[
		"a plain index made where a partitioned one was dropped",
		`${P}CREATE INDEX p_at ON p (at);\nCREATE TABLE z (at date);\nDROP INDEX p_at;\nCREATE INDEX p_at ON z (at);`,
		"REINDEX INDEX p_at",
	],
	[
		"a table made IF NOT EXISTS",
		"CREATE TABLE IF NOT EXISTS p (id int, at date) PARTITION BY RANGE (at);",
		"REINDEX TABLE p",
	],
	[
		"a table made LIKE another",
		"CREATE TABLE src (id int, at date);\nCREATE TABLE p (LIKE src) PARTITION BY RANGE (at);",
		"REINDEX TABLE p",
	],
	["an index made ON ONLY p", `${P}CREATE INDEX p_at ON ONLY p (at);`, "REINDEX INDEX p_at"],
	["a quoted mixed-case table", 'CREATE TABLE "Ev" (at date) PARTITION BY RANGE (at);', 'REINDEX TABLE "Ev"'],
	["a REINDEX with options", P, "REINDEX (VERBOSE) TABLE p"],
]

/** Whether Postgres refuses `statement` in a transaction block after `history` */
const postgresRefuses = (history: string, statement: string): Promise<boolean> =>
	afterHistory(history, async (client) => {
		await client.query("BEGIN")
		try {
			await client.query(statement)
			return false
		} catch (error) {
			if ((error as { code?: string }).code !== "25001") throw error
			return true
		} finally {
			await client.query("ROLLBACK")
		}
	})

/** comb's rating of `statement` after `history`, or the refusal it throws */
const combRates = (history: string, statement: string): ReturnType<typeof classifyMigration> =>
	classifyMigration(`${statement};\n`, { before: extractSchema(history, undefined, "postgres"), dialect: "postgres" })

/** Whether comb refuses `statement` after `history` as one Postgres runs only outside a transaction */
function combRefuses(history: string, statement: string): boolean {
	try {
		combRates(history, statement)
		return false
	} catch (error) {
		if (!(error as Error).message.includes("only outside a transaction")) throw error
		return true
	}
}

describe("partitioned refusals against Postgres 17", () => {
	it.each(REFUSALS)("refuses as Postgres does for %s", async (_label, history, statement) => {
		expect(combRefuses(history, statement)).toBe(await postgresRefuses(history, statement))
	})

	it("moves a partitioned index to another tablespace without a rewrite, as Postgres does", async () => {
		const history = `${P}CREATE INDEX p_at ON p (at);`
		const statement = "ALTER INDEX p_at SET TABLESPACE pg_default"
		/* the partitioned index has no storage: Postgres gives it no relfilenode before or after */
		const files = await afterHistory(history, async (client) => {
			const read = async () =>
				(await client.query<{ f: string }>("SELECT relfilenode::text AS f FROM pg_class WHERE relname = 'p_at'"))
					.rows[0]?.f
			const before = await read()
			await client.query(statement)
			return [before, await read()]
		})
		expect(files).toEqual(["0", "0"])
		expect(combRates(history, statement).lockWarnings).toEqual([])
	})
})
