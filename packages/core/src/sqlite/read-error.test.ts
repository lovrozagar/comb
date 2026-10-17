import { describe, expect, it } from "vitest"
import { readSqliteError } from "./read-error.ts"

/* the shapes below are the ones libsql, bun:sqlite, D1 (Miniflare) and drizzle produce */
const drizzle = (cause: unknown) =>
	Object.assign(new Error("Failed query: INSERT INTO member (id) VALUES (?)\nparams: secret", { cause }), {
		name: "DrizzleQueryError",
		params: ["secret"],
		query: 'insert into "member" ("id") values (?)',
	})

const libsql = (extendedCode: string, message: string) =>
	Object.assign(new Error(`SQLITE_CONSTRAINT: ${message}`), { code: "SQLITE_CONSTRAINT", extendedCode, rawCode: 2067 })

const bun = (code: string, message: string) => Object.assign(new Error(message), { code, errno: 2067 })

describe("readSqliteError", () => {
	it("reads libsql's extended code and strips its prefix", () => {
		const read = readSqliteError(drizzle(libsql("SQLITE_CONSTRAINT_UNIQUE", "UNIQUE constraint failed: member.email")))
		expect(read).toEqual({
			code: "SQLITE_CONSTRAINT_UNIQUE",
			message: "UNIQUE constraint failed: member.email",
			query: 'insert into "member" ("id") values (?)',
		})
	})

	it("reads bun:sqlite's code", () => {
		expect(readSqliteError(bun("SQLITE_CONSTRAINT_PRIMARYKEY", "UNIQUE constraint failed: member.id"))).toEqual({
			code: "SQLITE_CONSTRAINT_PRIMARYKEY",
			message: "UNIQUE constraint failed: member.id",
			query: undefined,
		})
	})

	it("reads D1's extended code from the message, wrapper or not", () => {
		const inner = new Error(
			"UNIQUE constraint failed: member.a, member.b: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)",
		)
		const outer = new Error(`D1_ERROR: ${inner.message}`, { cause: inner })
		expect(readSqliteError(drizzle(outer))).toEqual({
			code: "SQLITE_CONSTRAINT_UNIQUE",
			message: "UNIQUE constraint failed: member.a, member.b",
			query: 'insert into "member" ("id") values (?)',
		})
		expect(readSqliteError(new Error("D1_ERROR: no such column: reset_at at offset 7: SQLITE_ERROR"))).toEqual({
			code: "SQLITE_ERROR",
			message: "no such column: reset_at at offset 7",
			query: undefined,
		})
	})

	it("is null for anything that is not an SQLite engine error", () => {
		expect(readSqliteError(new Error("D1_ERROR: Network connection lost."))).toBeNull()
		expect(readSqliteError(Object.assign(new Error("x"), { code: "23505" }))).toBeNull()
		expect(readSqliteError(drizzle(new Error("reset")))).toBeNull()
		expect(readSqliteError("UNIQUE constraint failed: a.b")).toBeNull()
		expect(readSqliteError(null)).toBeNull()
	})

	it("stops on a cause cycle", () => {
		const a = new Error("a")
		const b = new Error("b", { cause: a })
		Object.assign(a, { cause: b })
		expect(readSqliteError(a)).toBeNull()
	})
})
