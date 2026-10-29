import { describe, expect, it } from "vitest"
import { readPgError } from "./read-error.ts"

/* driver shapes as node-postgres, postgres.js and Bun.SQL produce them; the real-server cases
 * live in tests/integration/postgres and tests/bun */
const nodePg = (fields: Record<string, string>) => Object.assign(new Error("server error"), fields)
const postgresJs = (fields: Record<string, string>) => Object.assign(new Error("server error"), fields)
const bunSql = (fields: Record<string, string>) =>
	Object.assign(new Error("server error"), { code: "ERR_POSTGRES_SERVER_ERROR", ...fields })
const wrapped = (cause: unknown) =>
	Object.assign(new Error("Failed query: insert ...", { cause }), { name: "DrizzleQueryError", query: "insert ..." })

/** The key columns readPgError reads from a unique violation's `detail` */
const keys = (detail: string) => readPgError(nodePg({ code: "23505", detail, table: "t" }))?.keyColumns

describe("readPgError", () => {
	it("reads every driver's field names, through wrappers", () => {
		const expected = {
			code: "23505",
			column: "c",
			constraint: "k",
			keyColumns: ["a", "b"],
			keyExpression: false,
			message: "server error",
			referenced: false,
			table: "t",
		}
		const detail = 'Key (a, "b")=(1, 2) already exists.'
		/* a wrapper adds the SQL it recorded, which no bare driver error holds */
		expect(readPgError(wrapped(nodePg({ code: "23505", column: "c", constraint: "k", detail, table: "t" })))).toEqual({
			...expected,
			query: "insert ...",
		})
		expect(
			readPgError(postgresJs({ code: "23505", column_name: "c", constraint_name: "k", detail, table_name: "t" })),
		).toEqual(expected)
		expect(readPgError(bunSql({ column: "c", constraint: "k", detail, errno: "23505", table: "t" }))).toEqual(expected)
	})

	/* U44: Postgres quotes a key column as an identifier, so one may hold a comma, a quote or a parenthesis */
	it("reads the key's columns as quoted identifiers", () => {
		expect(keys('Key ("x, y", z)=(1, 2) already exists.')).toEqual(["x, y", "z"])
		expect(keys('Key ("say ""hi""", "f(x)")=(1, 2) already exists.')).toEqual(['say "hi"', "f(x)"])
		/* Q3 of the 0.14.1 review: an expression is no column, and is marked */
		const lowered = readPgError(nodePg({ code: "23505", detail: "Key (id, lower(name::text))=(1, a) already exists." }))
		expect(lowered).toMatchObject({ keyColumns: ["id"], keyExpression: true })
		expect(keys("no key here")).toEqual([])
		expect(keys("Key (a, b")).toEqual([])
	})

	it("is null without a SQLSTATE", () => {
		expect(readPgError(new Error("x"))).toBeNull()
		expect(readPgError(Object.assign(new Error("x"), { code: "SQLITE_CONSTRAINT" }))).toBeNull()
		expect(readPgError(bunSql({}))).toBeNull()
		expect(readPgError(null)).toBeNull()
		expect(readPgError("23505")).toBeNull()
	})

	it("treats empty fields as absent", () => {
		expect(readPgError(nodePg({ code: "23502", column: "", table: "" }))).toMatchObject({
			column: undefined,
			table: undefined,
		})
	})
})

describe("readPgError on a wrapper that carries its own code", () => {
	it("reads the driver error under it: the server's error is the deepest", () => {
		const driver = nodePg({ code: "23505", constraint: "store_slug_key", table: "store" })
		const appWrapper = Object.assign(new Error("request failed: 57014"), { cause: driver, code: "57014" })
		expect(readPgError(appWrapper)).toMatchObject({ code: "23505", constraint: "store_slug_key" })
	})
})
