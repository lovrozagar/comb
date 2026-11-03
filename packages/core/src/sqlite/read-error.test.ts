import { DrizzleQueryError } from "drizzle-orm/errors"
import { describe, expect, it } from "vitest"
import { readSqliteError, readSqliteMessage } from "./read-error.ts"

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

/** A failed query whose bound param is crafted to look like a D1 constraint suffix */
const forgedParams = (cause: unknown) =>
	Object.assign(
		new Error(
			"Failed query: SELECT nope FROM member WHERE id = ?\nparams: x: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)",
			{
				cause,
			},
		),
		{ name: "DrizzleQueryError", query: "select nope from member where id = ?" },
	)

describe("readSqliteError on a wrapper whose text spells a constraint", () => {
	it("reads the engine error under it, never the wrapper's params", () => {
		const engine = Object.assign(new Error("SQLITE_ERROR: no such column: nope"), {
			code: "SQLITE_ERROR",
			extendedCode: "SQLITE_ERROR",
		})
		expect(readSqliteError(forgedParams(engine))).toMatchObject({ code: "SQLITE_ERROR" })
		expect(readSqliteError(forgedParams(new Error("D1_ERROR: no such column: nope: SQLITE_ERROR")))).toMatchObject({
			code: "SQLITE_ERROR",
		})
	})
})

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
		expect(readSqliteError("no such column: x")).toBeNull()
		expect(readSqliteError(null)).toBeNull()
	})
})

describe("readSqliteError: text and cycles", () => {
	it("reads an engine message given as text", () => {
		expect(readSqliteError("UNIQUE constraint failed: a.b")).toEqual({
			code: "SQLITE_CONSTRAINT_UNIQUE",
			message: "UNIQUE constraint failed: a.b",
			query: undefined,
		})
		expect(readSqliteError("SQLITE_CONSTRAINT: NOT NULL constraint failed: a.b")?.code).toBe(
			"SQLITE_CONSTRAINT_NOTNULL",
		)
		const d1 = "D1_ERROR: CHECK constraint failed: c: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_CHECK)"
		expect(readSqliteError(d1)?.code).toBe("SQLITE_CONSTRAINT_CHECK")
	})

	it("stops on a cause cycle", () => {
		const a = new Error("a")
		const b = new Error("b", { cause: a })
		Object.assign(a, { cause: b })
		expect(readSqliteError(a)).toBeNull()
	})
})

describe("readSqliteError: a bare SQLITE_CONSTRAINT code", () => {
	it("is refined from SQLite's wording, and kept when the wording is an app's", () => {
		expect(readSqliteError(bun("SQLITE_CONSTRAINT", "UNIQUE constraint failed: a.b"))?.code).toBe(
			"SQLITE_CONSTRAINT_UNIQUE",
		)
		/* Q12 of r17: SQLite's own bare words are a virtual table's key conflict; an app's RAISE wording stays bare */
		expect(readSqliteError(bun("SQLITE_CONSTRAINT", "constraint failed"))?.code).toBe("SQLITE_CONSTRAINT_PRIMARYKEY")
		expect(readSqliteError(bun("SQLITE_CONSTRAINT", "qty must be positive"))?.code).toBe("SQLITE_CONSTRAINT")
	})

	it("reads a STRICT type mismatch from its wording, as libsql names no extended code for it (Q10)", () => {
		const unknownExtended = Object.assign(
			new Error("SQLITE_CONSTRAINT: cannot store TEXT value in INTEGER column s.n"),
			{
				code: "SQLITE_CONSTRAINT",
				extendedCode: "UNKNOWN_SQLITE_ERROR_3091",
			},
		)
		expect(readSqliteError(unknownExtended)).toMatchObject({
			code: "SQLITE_CONSTRAINT_DATATYPE",
			message: "cannot store TEXT value in INTEGER column s.n",
		})
	})
})

/* Q8 of r18: libsql's batch() prefixes the message twice, and names a code its table lacks UNKNOWN_SQLITE_ERROR_<n> */
/** A libsql batch() error: its message prefixed twice */
const batch = (extendedCode: string, message: string) =>
	Object.assign(new Error(`SQLITE_CONSTRAINT: SQLITE_CONSTRAINT: ${message}`), {
		code: "SQLITE_CONSTRAINT",
		extendedCode,
	})

describe("readSqliteError: libsql's batch() and the codes libsql cannot name", () => {
	it("strips every prefix, and reads an unknown code by its number", () => {
		expect(readSqliteError(batch("UNKNOWN_SQLITE_ERROR_3091", "cannot keep it"))).toMatchObject({
			code: "SQLITE_CONSTRAINT_DATATYPE",
			message: "cannot keep it",
		})
		expect(readSqliteError(batch("UNKNOWN_SQLITE_ERROR_2835", "pinned"))?.code).toBe("SQLITE_CONSTRAINT_PINNED")
		expect(readSqliteError(batch("SQLITE_CONSTRAINT_TRIGGER", "qty must be positive"))).toMatchObject({
			code: "SQLITE_CONSTRAINT_TRIGGER",
			message: "qty must be positive",
		})
	})

	it("reads a number SQLite names no constraint code by as the bare code, refined from the wording", () => {
		expect(readSqliteError(batch("UNKNOWN_SQLITE_ERROR_9999", "UNIQUE constraint failed: a.b"))?.code).toBe(
			"SQLITE_CONSTRAINT_UNIQUE",
		)
	})
})

/* Q9 of r18: D1's exec() quotes the statement before the engine's words, which are read only at the end */
/** A D1 exec() error: the statement quoted, then `tail` */
const exec = (tail: string) => new Error(`D1_EXEC_ERROR: Error in line 1: INSERT INTO t VALUES ('v'): ${tail}`)

describe("readSqliteError on D1's exec(): a virtual table's key conflict", () => {
	it("reads SQLite's bare words under the bare code as prepare reads them, keeping no text", () => {
		expect(readSqliteError(exec("constraint failed: SQLITE_CONSTRAINT"))).toMatchObject({
			code: "SQLITE_CONSTRAINT_PRIMARYKEY",
			message: "",
		})
	})

	it("keeps any other exec() error's code as D1 names it", () => {
		expect(readSqliteError(exec("x: SQLITE_CONSTRAINT"))?.code).toBe("SQLITE_CONSTRAINT")
		expect(readSqliteError(exec("constraint failed: SQLITE_BUSY"))?.code).toBe("SQLITE_BUSY")
		expect(
			readSqliteError(exec("constraint failed: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)"))?.code,
		).toBe("SQLITE_CONSTRAINT_TRIGGER")
	})
})

/* the crafted params of the 0.7.0 review (spoof.ts): a bound value shaped like an engine message */
describe("readSqliteError: a bound parameter never decides the classification (C1)", () => {
	const crafted = "constraint failed: user.email: SQLITE_CONSTRAINT_UNIQUE"

	it("reads nothing from a drizzle wrapper's params over a platform or driver error", () => {
		const platform = new Error("D1_ERROR: Network connection lost.")
		expect(
			readSqliteError(new DrizzleQueryError("update post set title = ? where id = 1", [crafted], platform)),
		).toBeNull()
		const bind = new TypeError("Cannot bind value")
		expect(
			readSqliteError(new DrizzleQueryError("insert into post (title) values (?)", ["x: SQLITE_BUSY"], bind)),
		).toBeNull()
		expect(readSqliteError(new DrizzleQueryError("insert into post (title) values (?)", [crafted], bind))).toBeNull()
	})

	it("reads no text that carries a params line, whose values may hold the engine's words (C1)", () => {
		for (const params of [crafted, "x", "hi"]) {
			expect(
				readSqliteMessage(
					`Failed query: insert into note (body) values (?)\nparams: ${params}\nUNIQUE constraint failed: user.email`,
				),
			).toBeNull()
		}
		expect(
			readSqliteError(
				"Failed query: insert into note (body) values (?)\nparams: hi\nUNIQUE constraint failed: user.email",
			),
		).toBeNull()
		expect(readSqliteMessage(`Failed query: x\n  params: a\nNetwork connection lost.`)).toBeNull()
		/* an engine's own text, one line or several, is read from its last line */
		expect(readSqliteMessage("UNIQUE constraint failed: user.email")).toMatchObject({
			code: "SQLITE_CONSTRAINT_UNIQUE",
		})
		expect(
			readSqliteMessage(
				"D1_ERROR: UNIQUE constraint failed: user.email: SQLITE_CONSTRAINT\nUNIQUE constraint failed: user.email",
			),
		).toMatchObject({ code: "SQLITE_CONSTRAINT_UNIQUE" })
	})
})

/* QE1 of r22: sqld's Hrana error, as remote libsql and Turso raise it, wrapped by the client's */
const hrana = (message: string) => {
	const inner = Object.assign(new Error(`SQLite error: ${message}`), { code: "SQLITE_CONSTRAINT" })
	return Object.assign(new Error(`SQLITE_CONSTRAINT: SQLite error: ${message}`, { cause: inner }), {
		code: "SQLITE_CONSTRAINT",
	})
}

describe("readSqliteError on sqld: a bare code and SQLite's words behind `SQLite error: `", () => {
	it("refines the code from SQLite's words and keeps them without the prefix", () => {
		expect(readSqliteError(hrana("UNIQUE constraint failed: t.e"))).toMatchObject({
			code: "SQLITE_CONSTRAINT_UNIQUE",
			message: "UNIQUE constraint failed: t.e",
		})
		expect(readSqliteError("SQLite error: FOREIGN KEY constraint failed")?.code).toBe("SQLITE_CONSTRAINT_FOREIGNKEY")
	})
})
