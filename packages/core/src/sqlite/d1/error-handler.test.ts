import { describe, expect, it } from "vitest"
import { CombError } from "../../error.ts"
import { d1ErrorHandler } from "./error-handler.ts"

/* D1 shapes as workerd produces them; the real-engine cases live in tests/integration/d1 */
const d1 = (message: string) => {
	const inner = new Error(message)
	return new Error(`D1_ERROR: ${message}`, { cause: inner })
}
const wrapped = (cause: unknown, query: string) =>
	Object.assign(new Error(`Failed query: ${query}\nparams: reset`, { cause }), { name: "DrizzleQueryError", query })

function thrown(error: unknown): CombError | undefined {
	try {
		d1ErrorHandler(error, [])
	} catch (caught) {
		return caught as CombError
	}
	return undefined
}

describe("d1ErrorHandler", () => {
	it("maps constraint violations through the shared SQLite handler", () => {
		const unique = d1("UNIQUE constraint failed: member.email: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)")
		expect(thrown(unique)).toMatchObject({ column: "email", errorKey: "unique_constraint_violation", status: 409 })
	})

	it("reports query errors as 500 and a full database as 422", () => {
		expect(thrown(d1("no such table: member: SQLITE_ERROR"))).toMatchObject({
			errorKey: "database_io_error",
			status: 500,
		})
		expect(thrown(d1("database or disk is full: SQLITE_FULL"))).toMatchObject({
			errorKey: "tier_database_limit_reached",
			status: 422,
		})
	})

	it.each([
		["D1_ERROR: Network connection lost.", "database_unavailable", 503],
		[
			"D1_ERROR: D1 DB storage operation exceeded timeout which caused object to be reset.",
			"database_unavailable",
			503,
		],
		["D1_ERROR: Exceeded maximum DB size limit", "tier_database_limit_reached", 422],
		["D1_ERROR: Account storage limit reached", "tier_database_limit_reached", 422],
		["D1_ERROR: An unknown failure", "database_io_error", 500],
		["D1_EXEC_ERROR: Error in line 1: near x", "database_io_error", 500],
		["D1_TYPE_ERROR: Type 'object' not supported", "database_io_error", 500],
		["D1_COLUMN_NOTFOUND: Column not found", "database_io_error", 500],
	])("classifies the platform message %s", (message, errorKey, status) => {
		expect(thrown(wrapped(new Error(message), "SELECT 1"))).toMatchObject({ errorKey, status })
	})

	it("never reads the wrapper's SQL or params for platform words", () => {
		const quiet = wrapped(new Error("something else"), 'select "reset" from "D1_ERROR"')
		expect(thrown(quiet)).toBeUndefined()
	})

	it("gives the client a safe cause and keeps the original on source", () => {
		const source = wrapped(new Error("D1_ERROR: Network connection lost."), "SELECT secret")
		const error = thrown(source)
		expect(error?.cause).toBe("The database is temporarily unavailable. Please retry.")
		expect(error?.source).toBe(source)
	})

	it("leaves anything else alone", () => {
		expect(thrown(new Error("boom"))).toBeUndefined()
		expect(thrown("D1_ERROR: x")).toBeUndefined()
		expect(thrown(null)).toBeUndefined()
	})

	it("throws CombError instances", () => {
		expect(thrown(new Error("D1_ERROR: overloaded"))).toBeInstanceOf(CombError)
	})
})

describe("d1ErrorHandler: values embedded in D1 messages", () => {
	it.each([
		"D1_TYPE_ERROR: Type 'object' not supported for value 'please reset my password'",
		"D1_EXEC_ERROR: Error in line 1: near 'internal error': syntax error",
		"D1_COLUMN_NOTFOUND: Column 'reset' not found",
	])("never makes %s retryable", (message) => {
		expect(thrown(new Error(message))).toMatchObject({ errorKey: "database_io_error", status: 500 })
	})
})

describe("d1ErrorHandler: a D1 message without its extended code", () => {
	it("still maps the constraint", () => {
		const error = new Error("D1_ERROR: UNIQUE constraint failed: user.email_address: SQLITE_CONSTRAINT")
		expect(thrown(error)).toMatchObject({
			column: "email_address",
			errorKey: "unique_constraint_violation",
			status: 409,
		})
	})
})

describe("d1ErrorHandler on a wrapper whose message reads like D1", () => {
	it("classifies by the platform error under it, never the wrapper's words", () => {
		/* no SQLite code anywhere, so the platform message decides: the wrapper's words must not */
		const platform = new Error("D1_ERROR: Network connection lost.")
		const appWrapper = new Error("D1_ERROR: storage limit reached for request quota", { cause: platform })
		expect(() => d1ErrorHandler(appWrapper, [])).toThrow(
			expect.objectContaining({ errorKey: "database_unavailable", status: 503 }),
		)
	})
})

describe("d1ErrorHandler on the engine's resource codes (Q-D9)", () => {
	it.each([
		["database is locked: SQLITE_BUSY", "database_unavailable"],
		["database table is locked: SQLITE_LOCKED", "database_unavailable"],
		["attempt to write a readonly database: SQLITE_READONLY", "database_readonly"],
	])("maps %j to 503 %s, as the shared SQLite handler does", (message, errorKey) => {
		expect(thrown(d1(message))).toMatchObject({ errorKey, status: 503 })
	})
})

describe("d1ErrorHandler on a value the column cannot hold (Q10)", () => {
	it("answers a value over D1's limit and a STRICT type mismatch with a 400, as Postgres does", () => {
		expect(thrown(d1("string or blob too big: SQLITE_TOOBIG"))).toMatchObject({
			errorKey: "value_too_large",
			status: 400,
		})
		expect(
			thrown(
				d1("cannot store TEXT value in INTEGER column s.n: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_DATATYPE)"),
			),
		).toMatchObject({ column: "n", errorKey: "invalid_value", status: 400 })
	})
})
