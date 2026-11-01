/** comb.config.ts's partitions held to the analyzed tables (Q7 of r18) */
import fs from "node:fs"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { fixtureRoot } from "../__fixtures__/temp.ts"
import { analyze } from "../analyzer.ts"
import { partitionsOf } from "./constraints-partitions.ts"

const made: string[] = []
afterEach(() => {
	for (const dir of made.splice(0)) fs.rmSync(dir, { force: true, recursive: true })
})

/** The tables of `source`, analyzed */
function tablesOf(source: string) {
	const dir = fs.mkdtempSync(path.join(fixtureRoot(), "comb-partitions-"))
	made.push(dir)
	const file = path.join(dir, "db.test.tables.ts")
	fs.writeFileSync(file, source)
	return analyze(file).tables
}

const SQLITE = `import { sqliteTable, text } from "drizzle-orm/sqlite-core"
`
const USER = `export const user = sqliteTable("user", { id: text("id").primaryKey() })\n`
const AUDIT = `import { pgSchema, pgTable, text } from "drizzle-orm/pg-core"
export const audit = pgTable("audit", { id: text("id").primaryKey() })
export const orders = pgTable("orders", { id: text("id").primaryKey() })
export const app = pgSchema("app")
export const ledger = app.table("ledger", { id: text("id").primaryKey() })
`

describe("partitionsOf", () => {
	it("keys each partition as the map keys a table, once, and takes none as nothing to check", () => {
		const tables = tablesOf(AUDIT)
		expect(partitionsOf(tables, "postgres", { "app.ledger": ["l", "l"], audit: ["l"] })).toEqual(
			new Map([
				["app.ledger", ["app.l"]],
				["audit", ["l"]],
			]),
		)
		expect(partitionsOf(tablesOf(`${SQLITE}${USER}`), "sqlite", {})).toEqual(new Map())
	})

	it("refuses a parent no table is, a partition named twice or as a table, one in another schema, and SQLite", () => {
		const tables = tablesOf(AUDIT)
		expect(() => partitionsOf(tables, "postgres", { audits: ["audit_2026"] })).toThrow(
			'partitions: "audits" is no table of this database; key each partitioned table as its constraint map does',
		)
		expect(() => partitionsOf(tables, "postgres", { audit: ["p"], "app.ledger": ["p"], orders: ["p"] })).toThrow(
			'partitions: "p" is listed under both "audit" and "orders"; a partition has one parent',
		)
		expect(() => partitionsOf(tables, "postgres", { "app.ledger": ["ledger_x"], audit: ["audit"] })).toThrow(
			'partitions: "audit" lists "audit", which is a table of this database, not a partition',
		)
		expect(() => partitionsOf(tables, "postgres", { audit: ["other.audit_2026"] })).toThrow(
			'partitions: "audit" lists "other.audit_2026"; name a partition without a schema, as it lives in its parent\'s',
		)
		expect(() => partitionsOf(tablesOf(`${SQLITE}${USER}`), "sqlite", { user: ["user_1"] })).toThrow(
			"partitions: SQLite has no partitioned tables; list partitions on a Postgres database only",
		)
	})
})
