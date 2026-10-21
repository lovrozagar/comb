/**
 * SQLite and PostgreSQL give an app the same surface: the same `c` factories and the same
 * constraint handlers, except where the engines differ, which the ASYMMETRY list names. Every
 * entry of every error-handler table is exercised by an integration case on a real engine, or
 * the UNREACHABLE list says why no engine here can produce it.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parseSync } from "oxc-parser"
import { describe, expect, it } from "vitest"
import { c as pg } from "../../src/pg/columns.ts"
import { c as sqlite } from "../../src/sqlite/columns.ts"

const ROOT = join(import.meta.dirname, "../..")
const read = (path: string) => readFileSync(join(ROOT, path), "utf8")

/** The keys and value names of the object literal a module-level `const name = {…}` holds */
function tableOf(path: string, name: string): Record<string, string> {
	const { program } = parseSync(path, read(path))
	for (const statement of program.body) {
		if (statement.type !== "VariableDeclaration") continue
		for (const declarator of statement.declarations) {
			if (declarator.id.type !== "Identifier" || declarator.id.name !== name) continue
			if (declarator.init?.type !== "ObjectExpression") break
			const entries: Array<[string, string]> = []
			for (const property of declarator.init.properties) {
				if (property.type !== "Property") continue
				const key = property.key.type === "Identifier" ? property.key.name : String(Reflect.get(property.key, "value"))
				const value = property.value.type === "Identifier" ? property.value.name : property.value.type
				entries.push([key, value])
			}
			return Object.fromEntries(entries)
		}
	}
	throw new Error(`${path} declares no ${name}`)
}

const SQLITE_CONSTRAINTS = tableOf("src/sqlite/constraint-handler.ts", "CONSTRAINTS")
const PG_CONSTRAINTS = tableOf("src/pg/error-handler.ts", "CONSTRAINTS")
const PG_RESOURCE = tableOf("src/pg/error-handler.ts", "RESOURCE")

/* where the engines differ, and why */
const ASYMMETRY = {
	primaryKey:
		"SQLite reports a primary key violation under its own code; Postgres reports 23505 on <table>_pkey, which unique maps",
} as const

/* the integration suites that run each engine for real */
const SUITES = {
	d1: read("tests/integration/d1/error-handler.test.ts"),
	pg: read("tests/integration/postgres/error-handler.test.ts"),
	sqlite: read("tests/integration/sqlite/constraint-handler.test.ts"),
}

/* the error key each constraint handler throws in the suites' shared fixture map */
const FIXTURE_KEY: Record<string, string> = {
	check: "member_seats_invalid",
	foreignKey: "member_org_missing",
	notNull: "required_field_missing",
	primaryKey: "member_id_taken",
	unique: "member_email_taken",
}

/* table entries no engine here can produce, each with the reason */
const UNREACHABLE: Record<string, string> = {
	"08001": "a client-side connect failure: the driver raises it before any server answers",
	"08003": "the driver raises it for a connection that is already gone",
	"08004": "the server refuses the connection before a session exists",
	"08006": "a connection lost mid-protocol; the drivers report the socket close instead",
	"40001": "a serialization failure needs two sessions writing one shared table; these suites create TEMP tables only",
	"53000": "insufficient resources needs an exhausted server",
	"53100": "disk full needs a full volume",
	"53200": "out of memory needs an exhausted server",
	"53400": "a configuration limit, such as max_locks_per_transaction, needs the server reconfigured to a tiny one",
	"57P02": "a crash shutdown takes the server down",
	"57P03": "cannot-connect-now only answers new connections during startup or recovery",
}

/** Each factory's declared parameter count */
const arity = (c: Record<string, (...args: never[]) => unknown>) =>
	Object.fromEntries(Object.entries(c).map(([key, factory]) => [key, factory.length]))

describe("dialect parity", () => {
	it("gives both dialects the same c factories", () => {
		expect(Object.keys(pg).sort()).toEqual(Object.keys(sqlite).sort())
	})

	it("gives each factory the same parameters on both dialects (E-S4; types in column-parity.typetest.ts)", () => {
		expect(arity(pg)).toEqual(arity(sqlite))
	})

	it("handles the same constraint kinds, but for the listed asymmetry", () => {
		const sqliteKinds = new Set(Object.values(SQLITE_CONSTRAINTS))
		const pgKinds = new Set(Object.values(PG_CONSTRAINTS))
		const onlySqlite = [...sqliteKinds].filter((kind) => !pgKinds.has(kind))
		const onlyPg = [...pgKinds].filter((kind) => !sqliteKinds.has(kind))
		expect(onlySqlite).toEqual(Object.keys(ASYMMETRY))
		expect(onlyPg).toEqual([])
	})

	it("exercises every constraint kind on SQLite, D1 and Postgres", () => {
		const kinds = new Set([...Object.values(SQLITE_CONSTRAINTS), ...Object.values(PG_CONSTRAINTS)])
		for (const kind of kinds) {
			const key = FIXTURE_KEY[kind]
			expect(key, `no fixture key for ${kind}`).toBeDefined()
			for (const [suite, text] of Object.entries(SUITES)) {
				expect(text.includes(`"${key}"`), `${suite} never asserts ${kind} (${key})`).toBe(true)
			}
		}
	})

	it("exercises every Postgres resource code on the server, or says why it cannot", () => {
		const untested = Object.keys(PG_RESOURCE).filter(
			(code) => !SUITES.pg.includes(`(${code})`) && !(code in UNREACHABLE),
		)
		expect(untested).toEqual([])
		/* an UNREACHABLE entry that a suite now covers, or that left the table, must go */
		const stale = Object.keys(UNREACHABLE).filter((code) => SUITES.pg.includes(`(${code})`) || !(code in PG_RESOURCE))
		expect(stale).toEqual([])
	})

	it("maps D1's storage limit only in the unit suite: Miniflare refuses max_page_count (SQLITE_AUTH)", () => {
		const d1 = read("src/sqlite/d1/error-handler.ts")
		/* D1 reads SQLITE_FULL through the shared SQLite resource table */
		expect(d1).toContain("resourceOutcome(code)")
		expect(read("src/sqlite/d1/error-handler.test.ts")).toContain("SQLITE_FULL")
	})
})
