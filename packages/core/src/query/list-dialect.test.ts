/**
 * Which dialect a derived list is built for (Q1 of r21): the columns its id, anchor and keys hold decide,
 * wherever drizzle's SQL hides them, and a list that holds none states `dialect`. Postgres reads a key's
 * type from its operand, so its list selects no `_combKeyTypes`; SQLite's selects `typeof()` of each key.
 * 0.19.0 looked at the top-level option alone and sent SQLite's typeof() to Postgres for every shape here
 * whose column is not the option itself (`.tmp/grunt/r21-premise/q1-shapes.log`).
 */
import { type SQL, type SQLWrapper, sql } from "drizzle-orm"
import {
	integer as pgInteger,
	PgDialect,
	pgTable,
	QueryBuilder as PgQueryBuilder,
	text as pgText,
} from "drizzle-orm/pg-core"
import { int as mysqlInt, mysqlTable, varchar } from "drizzle-orm/mysql-core"
import { integer, QueryBuilder, SQLiteDialect, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { SEALED } from "./__fixtures__/cursor-secret.ts"
import { createCursor } from "./cursor-mint.ts"
import { buildDerivedListQuery } from "./sqlite/build-list-query.ts"

const pgInbox = pgTable("inbox", { at: pgInteger("at"), uid: pgText("uid").primaryKey() })
const liteInbox = sqliteTable("inbox", { at: integer("at"), uid: text("uid").primaryKey() })
const mysqlInbox = mysqlTable("inbox", { at: mysqlInt("at"), uid: varchar("uid", { length: 36 }).primaryKey() })
const pgSub = new PgQueryBuilder().select({ at: pgInbox.at, uid: pgInbox.uid }).from(pgInbox).as("sq")
const liteSub = new QueryBuilder().select({ at: liteInbox.at, uid: liteInbox.uid }).from(liteInbox).as("sq")

type Key = SQLWrapper | { sql: SQLWrapper; type: "date" }
type Dialect = "postgres" | "sqlite"
const sides = {
	postgres: { at: pgInbox.at, compile: new PgDialect(), sub: pgSub, uid: pgInbox.uid },
	sqlite: { at: liteInbox.at, compile: new SQLiteDialect(), sub: liteSub, uid: liteInbox.uid },
}

/* every place a column can sit in a derived list's id and key, by its dialect's own columns */
const SHAPES: Array<[string, (d: Dialect) => { idColumn: SQLWrapper; key: Key }]> = [
	["the option itself", (d) => ({ idColumn: sides[d].uid, key: sides[d].at })],
	["only the key", (d) => ({ idColumn: sql`inbox.uid`, key: sides[d].at })],
	["only the id", (d) => ({ idColumn: sides[d].uid, key: sql`inbox.at` })],
	["inside an sql`` template", (d) => ({ idColumn: sql`${sides[d].uid}`, key: sql`coalesce(${sides[d].at}, 0)` })],
	["nested SQL", (d) => ({ idColumn: sql`lower(${sql`trim(${sides[d].uid})`})`, key: sql`inbox.at` })],
	["an aliased expression", (d) => ({ idColumn: sql`${sides[d].uid}`.as("uid"), key: sql`inbox.at` })],
	[
		"{ sql, type: date }",
		(d) => ({ idColumn: sql`inbox.uid`, key: { sql: sql`${sides[d].at} * 1000`, type: "date" } }),
	],
	[
		"beside a placeholder",
		(d) => ({ idColumn: sql`coalesce(${sql.placeholder("u")}, ${sides[d].uid})`, key: sql`inbox.at` }),
	],
	["a subquery field", (d) => ({ idColumn: sides[d].sub.uid, key: sides[d].sub.at })],
]

const parsedSort = [{ direction: "desc" as const, field: "at" as const }]
const cursor = createCursor({ at: 5, id: "a" }, parsedSort, SEALED)

/** The list built on its first page, or by `cursor`, with `extra` options */
const build = (
	idColumn: SQLWrapper,
	key: Key,
	{ byCursor = false, ...extra }: { baseWhere?: SQL; byCursor?: boolean; dialect?: Dialect } = {},
) =>
	buildDerivedListQuery({
		...SEALED,
		...extra,
		idColumn,
		parsed: { ...(byCursor ? { cursor } : {}), limit: 2, parsedSort },
		sortColumns: { at: key },
	})

/** Whether the built list selects SQLite's typeof(), compiled on `dialect` */
const sendsTypeof = (built: ReturnType<typeof build>, dialect: Dialect): boolean => {
	const types = (built.extras as Record<string, { sql: SQL } | undefined>)["_combKeyTypes"]
	return types !== undefined && sides[dialect].compile.sqlToQuery(types.sql).sql.includes("typeof(")
}

/** A list whose id is a Postgres column and whose key is a SQLite one */
const mixed = () => build(pgInbox.uid, liteInbox.at)

describe("a derived list's dialect, from the columns it holds (Q1 of r21)", () => {
	describe.each(["postgres", "sqlite"] as const)("%s columns", (dialect) => {
		it.each(SHAPES)("decides it from a column %s, by page and by cursor, with no option", (_, shape) => {
			const { idColumn, key } = shape(dialect)
			for (const byCursor of [false, true])
				expect(sendsTypeof(build(idColumn, key, { byCursor }), dialect)).toBe(dialect === "sqlite")
		})

		it.each(SHAPES)("accepts a stated dialect that agrees with a column %s", (_, shape) => {
			const { idColumn, key } = shape(dialect)
			expect(sendsTypeof(build(idColumn, key, { dialect }), dialect)).toBe(dialect === "sqlite")
		})

		it("refuses a stated dialect the columns contradict, naming both, on the first page", () => {
			const other = dialect === "postgres" ? "sqlite" : "postgres"
			const make = () => build(sides[dialect].uid, sides[dialect].at, { dialect: other })
			expect(make).toThrow(TypeError)
			expect(make).toThrow(new RegExp(`dialect "${other}".*${dialect}`))
		})
	})

	it.each([
		["all expressions (a union inbox)", sql`inbox.uid`, sql`inbox.at`],
		["all sql.raw", sql.raw("inbox.uid"), sql.raw("inbox.at")],
		["a placeholder and expressions", sql`${sql.placeholder("u")}`, sql`inbox.at`],
	])("needs `dialect` where %s hold no column: a TypeError naming it on the first page, every call", (_, id, key) => {
		for (let call = 0; call < 2; call++) {
			expect(() => build(id, key)).toThrow(TypeError)
			expect(() => build(id, key)).toThrow(/`dialect`/)
		}
		expect(sendsTypeof(build(id, key, { dialect: "postgres" }), "postgres")).toBe(false)
		expect(sendsTypeof(build(id, key, { dialect: "sqlite" }), "sqlite")).toBe(true)
	})

	it.each([
		["postgres", pgInbox],
		["sqlite", liteInbox],
	] as const)("decides an anchored list from its anchor's %s column, with no option", (dialect, table) => {
		const built = buildDerivedListQuery({
			...SEALED,
			anchor: { idColumn: table.uid, table },
			parsed: { limit: 2, parsedSort },
			sortColumns: { at: sql`inbox.at` },
		})
		expect(sendsTypeof(built, dialect)).toBe(dialect === "sqlite")
	})
})

describe("a derived list's wiring the dialect walk refuses (Q1 of r21)", () => {
	it("counts no column of the where: a list whose only column is in baseWhere still needs `dialect`", () => {
		expect(() => build(sql`inbox.uid`, sql`inbox.at`, { baseWhere: sql`${pgInbox.at} > 0` })).toThrow(/`dialect`/)
	})

	it("refuses columns of both dialects in one list, naming both", () => {
		expect(mixed).toThrow(TypeError)
		expect(mixed).toThrow(/postgres.*sqlite|sqlite.*postgres/)
	})

	it.each([
		["the id", mysqlInbox.uid, sql`inbox.at`],
		["a key, inside an expression", sql`inbox.uid`, sql`coalesce(${mysqlInbox.at}, 0)`],
	])("refuses a column of neither dialect in %s, naming its type, even with `dialect` stated", (_, id, key) => {
		for (const dialect of [undefined, "sqlite"] as const) {
			const make = () => build(id, key, dialect === undefined ? {} : { dialect })
			expect(make).toThrow(TypeError)
			expect(make).toThrow(/Postgres or SQLite.*MySql/)
		}
	})
})

describe("the dialect walk reads only drizzle's public surface", () => {
	const source = readFileSync(new URL("list-dialect.ts", import.meta.url), "utf8").replace(
		/\/\*[\s\S]*?\*\/|\/\/.*$/gm,
		"",
	)

	it("touches no drizzle entity symbol or private field", () => {
		expect(source).not.toMatch(/Symbol|entityKind|\b_\.|\["_/)
	})

	it("reads no property of a walked value beyond queryChunks, sql and columnType", () => {
		const read = new Set([...source.matchAll(/\b(?:value|chunk|wrapper)\.(\w+)/g)].map(([, name]) => name))
		expect([...read].filter((name) => !["columnType", "queryChunks", "sql"].includes(name as string))).toEqual([])
	})
})
