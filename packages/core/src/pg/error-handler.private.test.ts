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

/* Q3 of the 0.14.1 review: an expression index's key spells the columns it reads, a private one too */
describe("classifyPgError: a unique index on an expression", () => {
	const lowered = nodePg({
		code: "23505",
		constraint: "doc_secret_lower_key",
		detail: "Key (lower(secret::text))=(x) already exists.",
	})
	const mapped: ConstraintMap[] = [{ doc: { private: ["secret"], unique: { doc_secret_lower_key: ENTRY } } }]

	it("names no column of the key, private or not, in its column or cause", () => {
		for (const maps of [doc(true), doc(false)]) {
			const found = classifyPgError(lowered, maps)
			expect(found).toMatchObject({ cause: "Duplicate value detected", errorKey: "unique_constraint_violation" })
			expect(found?.column).toBeUndefined()
			expect(String(found?.cause)).not.toContain("secret")
		}
	})

	it("still resolves the map's entry for the index, by its name", () => {
		const found = classifyPgError(lowered, mapped)
		expect(found).toMatchObject({ errorKey: "doc_duplicate" })
		expect(found?.column).toBeUndefined()
	})
})

/** A node-postgres error under drizzle's wrapper, which records the statement */
const underStatement = (fields: Record<string, string>, query: string) =>
	Object.assign(new Error(`Failed query: ${query}`, { cause: nodePg(fields) }), { name: "DrizzleQueryError", query })

/* Q9 of r17: Postgres reports a partitioned table's violation on the partition, which no map key names */
describe("classifyPgError on a partition of a mapped table", () => {
	const maps: ConstraintMap[] = [{ member: { private: ["api_token"] } }]

	it("reads the statement's table, the parent, and keeps its private column private", () => {
		const insert = 'insert into "member" ("api_token", "region") values ($1, $2)'
		const duplicate = underStatement(
			{ code: "23505", detail: "Key (api_token, region)=(t, eu) already exists.", table: "member_eu" },
			insert,
		)
		expect(classifyPgError(duplicate, maps)).toMatchObject({ cause: "Duplicate value detected", table: "member" })
		const missing = underStatement({ code: "23502", column: "api_token", table: "member_eu" }, insert)
		expect(classifyPgError(missing, maps)).toMatchObject({ cause: "Required field missing", table: "member" })
		expect(classifyPgError(missing, maps)?.column).toBeUndefined()
	})

	it("names no column of a table no map knows, with no statement to find its parent", () => {
		const missing = nodePg({ code: "23502", column: "api_token", table: "member_eu" })
		expect(classifyPgError(missing, maps)).toMatchObject({ cause: "Required field missing" })
		expect(classifyPgError(missing, maps)?.column).toBeUndefined()
		const duplicate = nodePg({ code: "23505", detail: "Key (api_token)=(t) already exists.", table: "member_eu" })
		expect(classifyPgError(duplicate, maps)).toMatchObject({ cause: "Duplicate value detected" })
	})
})

/* Q18 of r17: a composite foreign key's first column may sit beside a private one */
describe("classifyPgError on a composite foreign key", () => {
	it("names no column, and none of a private one in the cause", () => {
		const maps: ConstraintMap[] = [{ child: { private: ["secret_ref"] } }]
		const failed = classifyPgError(
			nodePg({
				code: "23503",
				detail: 'Key (org_id, secret_ref)=(o, s) is not present in table "parent".',
				table: "child",
			}),
			maps,
		)
		expect(failed).toMatchObject({ errorKey: "foreign_key_violation", table: "child" })
		expect(failed?.column).toBeUndefined()
		expect(String(failed?.cause)).not.toContain("secret_ref")
	})
})
