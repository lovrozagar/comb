import { describe, expect, it } from "vitest"
import { generateConstraintMapCode } from "./constraints-code.ts"

describe("generateConstraintMapCode", () => {
	/* U43: a table's referenced columns are written as a list, sorted among its groups */
	it("writes a table's referenced columns as a list beside its constraints", () => {
		const code = generateConstraintMapCode(
			{
				user: {
					primaryKey: { cause: "Taken", errorKey: "user_id_duplicate", statusKey: "conflict" },
					referenced: ["id", "slug"],
				},
			},
			"test",
		)
		expect(code).toBe(`export const TEST_DB_CONSTRAINT_MAP = {
	/* user table constraints */
	user: {
		/* primary key constraint */
		primaryKey: {
			errorKey: "user_id_duplicate",
			cause: "Taken",
			statusKey: "conflict",
		},
		/* columns other tables' foreign keys reference */
		referenced: ["id", "slug"]
	}
} as const
`)
	})

	/* F67: a table's private columns are written as a list, which the handlers read */
	it("writes a table's private columns as a list beside its constraints", () => {
		const code = generateConstraintMapCode({ doc: { private: ["pin", "secret"], referenced: ["id"] } }, "test")
		expect(code).toBe(`export const TEST_DB_CONSTRAINT_MAP = {
	/* doc table constraints */
	doc: {
		/* private columns, which no error names */
		private: ["pin", "secret"],
		/* columns other tables' foreign keys reference */
		referenced: ["id"]
	}
} as const
`)
	})

	/* KT8 of r22b: every optional key takes undefined, which reads as the key left out */
	it("writes a group set to undefined as it writes one left out", () => {
		const primaryKey = { cause: "Taken", errorKey: "user_id_duplicate", statusKey: "conflict" } as const
		const unset = { check: undefined, private: undefined, referenced: undefined, unique: undefined }
		expect(generateConstraintMapCode({ user: { primaryKey, ...unset } }, "test")).toBe(
			generateConstraintMapCode({ user: { primaryKey } }, "test"),
		)
		expect(generateConstraintMapCode({ user: unset }, "test")).toBe(generateConstraintMapCode({ user: {} }, "test"))
	})
})
