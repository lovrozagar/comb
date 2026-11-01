import { describe, expect, it } from "vitest"
import { combErrorKeys } from "../types.ts"
import { resourceOutcome } from "./resource-outcome.ts"

describe("resourceOutcome", () => {
	it("answers a resource code, its extended form as its primary", () => {
		expect(resourceOutcome("SQLITE_BUSY")).toMatchObject({
			errorKey: "database_unavailable",
			status: "service_unavailable",
		})
		expect(resourceOutcome("SQLITE_READONLY_DBMOVED")).toMatchObject({ errorKey: "database_readonly" })
		expect(resourceOutcome("SQLITE_FULL")).toMatchObject({ errorKey: combErrorKeys.STORAGE_LIMIT_REACHED })
	})

	it("is undefined for any other code, and for none", () => {
		expect(resourceOutcome("SQLITE_CONSTRAINT_UNIQUE")).toBeUndefined()
		expect(resourceOutcome(undefined)).toBeUndefined()
	})
})
