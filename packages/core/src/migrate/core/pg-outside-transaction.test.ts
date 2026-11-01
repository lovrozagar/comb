import { beforeAll, describe, expect, it } from "vitest"
import { nodeOf, outsideOnly } from "./pg-outside-transaction.ts"
import { loadPostgresParser, parsePostgres } from "./pg-parser.ts"

beforeAll(loadPostgresParser)

/** What `sql`'s one statement is when Postgres runs it only outside a transaction */
const outside = (sql: string) => outsideOnly(...nodeOf(parsePostgres(sql).stmts))

/** A CREATE SUBSCRIPTION with `options`, as outsideOnly reads it */
const create = (options: string) => outside(`CREATE SUBSCRIPTION s CONNECTION 'x' PUBLICATION p${options}`)

/* P8 of r19: the one table, as Postgres 17 refused each in a transaction block (.tmp/grunt/p18/runs/8954e05-probe-p8-*.log) */
describe("outsideOnly", () => {
	it.each([
		["CREATE UNIQUE INDEX CONCURRENTLY i ON t (a)", "CREATE INDEX CONCURRENTLY"],
		["DROP INDEX CONCURRENTLY IF EXISTS i", "DROP INDEX CONCURRENTLY"],
		["REINDEX INDEX CONCURRENTLY i", "REINDEX CONCURRENTLY"],
		["ALTER TABLE ev DETACH PARTITION ev_old CONCURRENTLY", "ALTER TABLE ... DETACH CONCURRENTLY"],
		["VACUUM", "VACUUM"],
		["REINDEX SCHEMA s", "REINDEX SCHEMA"],
	])("names %j as Postgres's refusal does", (sql, named) => {
		expect(outside(sql)).toBe(named)
	})

	it("reads a subscription's options as Postgres reads a boolean: false, off or 0, and none given as true", () => {
		expect(
			["", " WITH (create_slot)", " WITH (create_slot = true)", " WITH (create_slot = 1)", " WITH (connect = on)"].map(
				create,
			),
		).toEqual(Array(5).fill("CREATE SUBSCRIPTION ... WITH (create_slot = true)"))
		expect(
			[
				" WITH (create_slot = false)",
				" WITH (create_slot = OFF)",
				" WITH (create_slot = 0)",
				" WITH (connect = false)",
			].map(create),
		).toEqual(Array(4).fill(undefined))
	})

	it("leaves out what a transaction holds", () => {
		expect(
			[
				"ANALYZE t",
				"CLUSTER t USING i",
				"REINDEX TABLE t",
				"ALTER TABLE ev DETACH PARTITION ev_old FINALIZE",
				"DISCARD TEMP",
				"COMMIT",
				"ALTER DATABASE d SET work_mem = '4MB'",
				"ALTER DATABASE d WITH CONNECTION LIMIT 5",
				"ALTER SUBSCRIPTION s DROP PUBLICATION p WITH (refresh = false)",
				"ALTER SUBSCRIPTION s DISABLE",
			].map(outside),
		).toEqual(Array(10).fill(undefined))
	})
})
