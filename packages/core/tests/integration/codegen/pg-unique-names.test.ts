/**
 * The 0.12 codegen review's F31: drizzle-kit writes a column's unnamed `.unique()` as a bare UNIQUE,
 * which Postgres names `<table>_<column>_key`, cutting the longer part first when the name passes 63
 * bytes. codegen publishes the name Postgres gives it, read here from Postgres 17 itself.
 */
import { pgTable, text } from "drizzle-orm/pg-core"
import { describe, expect, it } from "vitest"
import { analyzeNamespace } from "../../../src/codegen/__fixtures__/runtime.ts"
import { usePg } from "../support/pg.ts"

const pg = usePg()

/** The name Postgres 17 gives the unnamed UNIQUE of `column` on a new table `table` */
async function postgresName(table: string, column: string): Promise<string> {
	const client = pg.pg()
	await client.query(`CREATE TEMP TABLE "${table}" ("${column}" text UNIQUE)`)
	const { rows } = await client.query<{ conname: string }>(
		"SELECT c.conname FROM pg_constraint c JOIN pg_class r ON r.oid = c.conrelid WHERE c.contype = 'u' AND r.relnamespace = pg_my_temp_schema()",
	)
	return rows[0]?.conname as string
}

/** The name codegen publishes for that unique */
const published = (table: string, column: string) =>
	analyzeNamespace({ t: pgTable(table, { c: text(column).unique() }) }).tables[0]?.fields[0]?.unique

describe("the name a Postgres column's unnamed unique takes (F31)", () => {
	it.each([
		["account", "email"],
		["a".repeat(40), "b".repeat(30)],
		["short", "c".repeat(60)],
		["a".repeat(70), "email"],
		["ü".repeat(30), "é".repeat(10)],
		["t", "é".repeat(31)],
	])("is the name Postgres gives it: %s.%s", async (table, column) => {
		expect(published(table, column)).toBe(await postgresName(table, column))
	})
})
