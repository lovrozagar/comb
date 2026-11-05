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
import { P, REFUSALS } from "../support/partitioned-refusals.ts"
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
