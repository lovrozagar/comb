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
})
