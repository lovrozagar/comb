/**
 * F67 of the 0.13.0 round: an error names no column the map lists as private, in its `column` or
 * its cause, as the client reads both; a map without the list names each column as before
 */
import { describe, expect, it } from "vitest"
import type { ConstraintMap } from "../types.ts"
import { classifyPgError } from "./error-handler.ts"

const nodePg = (fields: Record<string, string>) => Object.assign(new Error("server error"), { table: "doc", ...fields })

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

/* each violation that names its column, with what it names there */
const CASES = [
	{ e: nodePg({ code: "23505", detail: "Key (secret)=(x) already exists." }), named: { column: "secret" } },
	{
		e: nodePg({ code: "23505", constraint: "doc_owner_pin_key", detail: "Key (owner, pin)=(a, b) already exists." }),
		hidden: { cause: "Duplicate value detected" },
		named: { cause: "Duplicate value for doc.owner, doc.pin" },
	},
	{
		e: nodePg({ code: "23503", detail: 'Key (owner_ref)=(u1) is not present in table "user".' }),
		named: { column: "owner_ref" },
	},
	{
		e: nodePg({ code: "23502", column: "secret" }),
		hidden: { cause: "Required field missing" },
		named: { cause: "Required field missing: secret", column: "secret" },
	},
	{
		e: nodePg({ code: "22001", column: "pin" }),
		hidden: { cause: "Invalid value" },
		named: { cause: "Invalid value for pin", column: "pin" },
	},
]

describe("classifyPgError: a private column (F67)", () => {
	it("is named in no error's column or cause", () => {
		for (const { e, hidden } of CASES) {
			const found = classifyPgError(e, doc(true))
			expect(found?.column).toBeUndefined()
			expect(found).toMatchObject(hidden ?? {})
			for (const name of ["secret", "owner_ref", "pin"]) expect(String(found?.cause)).not.toContain(name)
		}
	})

	it("is named as before by a map that lists no private columns", () => {
		for (const { e, named } of CASES) expect(classifyPgError(e, doc(false))).toMatchObject(named)
	})
})
