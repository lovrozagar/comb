import { defineRelations, getTableColumns, type SQL } from "drizzle-orm"
import { drizzle as pgDrizzle } from "drizzle-orm/node-postgres"
import { integer as pgInteger, pgTable, timestamp as pgTimestamp } from "drizzle-orm/pg-core"
import { integer, SQLiteDialect, sqliteTable } from "drizzle-orm/sqlite-core"
import { describe, expect, it } from "vitest"
import { queryHelpers } from "./drizzle.ts"
import { SEALED } from "./__fixtures__/cursor-secret.ts"

const dialect = new (SQLiteDialect as unknown as new () => {
	sqlToQuery: (sql: SQL) => { params: unknown[]; sql: string }
})()

const sortedBy = (field: string, direction: "asc" | "desc") => ({
	validated: true as const,
	parsedSort: [{ direction, field }],
})

/* B2-3 of area B: listOptions selects each SQLite timestamp key's TEXT, which paginate needs and strips */
describe("queryHelpers.listOptions' _combTextKeys (B2-3 of area B; sibling: _combKeyTexts on every sort)", () => {
	const stamped = sqliteTable("stamped", {
		at: integer("at", { mode: "timestamp" }),
		id: integer("id").primaryKey(),
		n: integer("n"),
	})
	const pgStamped = pgTable("pg_stamped", { at: pgTimestamp("at"), id: pgInteger("id").primaryKey() })
	const byAt = { limit: 1, ...sortedBy("at", "asc") }

	it("carries a SQLite timestamp key's TEXT as a JSON array, null for another key, and is empty with no such key", () => {
		const options = queryHelpers.listOptions(
			{ limit: 1, validated: true, parsedSort: [...byAt.parsedSort, { direction: "asc", field: "n" }] },
			SEALED,
		)
		expect(options.pagination.expects).toContain("_combTextKeys")
		const texts = options.extras["_combTextKeys"]!
		expect(dialect.sqlToQuery(texts(getTableColumns(stamped))).sql).toBe(
			`json_array(case when typeof("stamped"."at") = 'text' then "stamped"."at" end, null)`,
		)
		const byN = queryHelpers.listOptions({ limit: 1, ...sortedBy("n", "asc") }, SEALED)
		expect(dialect.sqlToQuery(byN.extras["_combTextKeys"]!(getTableColumns(stamped))).sql).toBe("''")
	})

	it("renders an empty text on Postgres, no json_array, a timestamp key included", () => {
		const db = pgDrizzle.mock({ relations: defineRelations({ pgStamped }) })
		const rendered = db.query.pgStamped.findMany(queryHelpers.listOptions(byAt, SEALED) as never).toSQL().sql
		expect(rendered).toContain(`('') as "_combTextKeys"`)
		expect(rendered).not.toContain("json_array")
	})

	/* AB3-4 of area B: a Postgres time key carries its to_json text on the relational list too; SQLite has no to_json */
	it("carries a Postgres timestamp key's to_json text, and nothing for a SQLite one", () => {
		const options = queryHelpers.listOptions(byAt, SEALED)
		const db = pgDrizzle.mock({ relations: defineRelations({ pgStamped }) })
		expect(db.query.pgStamped.findMany(options as never).toSQL().sql).toContain(
			`(coalesce((to_json("d0"."at") #>> '{}'), '')) as "_combKeyTexts"`,
		)
		expect(dialect.sqlToQuery(options.extras["_combKeyTexts"]!(getTableColumns(stamped))).sql).toBe("''")
	})

	it("is stripped from the served rows, and a page whose rows lack it is a 500 page_not_wired naming it", () => {
		const options = queryHelpers.listOptions(byAt, SEALED)
		const row = { _combId: 1, _combKeyTexts: "", _combTextKeys: '["now"]', _total: 1, at: new Date(Number.NaN), id: 1 }
		const [items] = queryHelpers.paginate([row], options)
		expect(items).toEqual([{ at: row.at, id: 1 }])
		const { _combTextKeys: _, ...lacking } = row
		expect(() => queryHelpers.paginate([lacking], options)).toThrow(
			expect.objectContaining({ cause: expect.stringContaining("_combTextKeys"), errorKey: "page_not_wired" }),
		)
	})
})
