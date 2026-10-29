/**
 * F67 of the 0.13.0 round: an error names no column the map lists as private, in its `column` or
 * its cause, as the client reads both; a map without the list names each column as before
 */
import { describe, expect, it } from "vitest"
import type { ConstraintMap } from "../types.ts"
import { constraintError } from "./constraint-handler.ts"

const engine = (code: string, message: string) => Object.assign(new Error(message), { code })
const wrapped = (cause: unknown, query: string) =>
	Object.assign(new Error(`Failed query: ${query}`, { cause }), { name: "DrizzleQueryError", query })

const ENTRY = { cause: "A record with these values already exists", errorKey: "doc_duplicate" }
const doc = (listed: boolean): ConstraintMap[] => [
	{
		doc: {
			foreignKey: { owner_ref: { cause: "Referenced record does not exist", errorKey: "doc_reference_not_found" } },
			...(listed ? { private: ["secret", "owner_ref", "pin"] } : {}),
			unique: { secret: ENTRY },
		},
	},
]

const error = (e: unknown, listed = true) => constraintError(e, doc(listed))

/* each violation that names its column, with what it names there */
const CASES = [
	{ e: engine("SQLITE_CONSTRAINT_UNIQUE", "UNIQUE constraint failed: doc.secret"), named: { column: "secret" } },
	{
		e: engine("SQLITE_CONSTRAINT_UNIQUE", "UNIQUE constraint failed: doc.owner, doc.pin"),
		hidden: { cause: "Duplicate value detected" },
		named: { cause: "Duplicate value for doc.owner, doc.pin" },
	},
	{
		e: wrapped(
			engine("SQLITE_CONSTRAINT_FOREIGNKEY", "FOREIGN KEY constraint failed"),
			'insert into "doc" ("id", "owner_ref") values (?, ?)',
		),
		named: { column: "owner_ref" },
	},
	{
		e: engine("SQLITE_CONSTRAINT_NOTNULL", "NOT NULL constraint failed: doc.secret"),
		hidden: { cause: "Required field missing" },
		named: { cause: "Required field missing: secret", column: "secret" },
	},
	{
		e: engine("SQLITE_CONSTRAINT_DATATYPE", "cannot store TEXT value in INTEGER column doc.pin"),
		hidden: { cause: "Invalid value" },
		named: { cause: "Invalid value for pin", column: "pin" },
	},
]

describe("constraintError: a private column (F67)", () => {
	it("is named in no error's column or cause", () => {
		for (const { e, hidden } of CASES) {
			const found = error(e)
			expect(found?.column).toBeUndefined()
			expect(found).toMatchObject(hidden ?? {})
			for (const name of ["secret", "owner_ref", "pin"]) expect(String(found?.cause)).not.toContain(name)
		}
	})

	it("is named as before by a map that lists no private columns", () => {
		for (const { e, named } of CASES) expect(error(e, false)).toMatchObject(named)
	})
})

/* Q19 of r17: with no SQL recorded, a column whose name holds a dot is split at the table a map knows */
describe("a private column whose name holds a dot, no statement recorded", () => {
	it("is found under its table, so it stays private", () => {
		const maps: ConstraintMap[] = [{ member: { private: ["api.token"] } }]
		const failed = constraintError(
			engine("SQLITE_CONSTRAINT_UNIQUE", "UNIQUE constraint failed: member.api.token"),
			maps,
		)
		expect(failed).toMatchObject({ cause: "Duplicate value detected", table: "member" })
		expect(failed?.column).toBeUndefined()
	})

	it("is split on its last dot when no map names a table it starts with", () => {
		const failed = constraintError(engine("SQLITE_CONSTRAINT_UNIQUE", "UNIQUE constraint failed: member.api.token"), [])
		expect(failed).toMatchObject({ column: "token", table: "member.api" })
	})
})
