import { describe, expect, it } from "vitest"
import { DatabaseMissing } from "./missing.ts"

describe("DatabaseMissing", () => {
	it("is an Error named for what it is, with the reader's message", () => {
		const error = new DatabaseMissing("core.db does not exist")
		expect(error).toBeInstanceOf(Error)
		expect([error.name, error.message]).toEqual(["DatabaseMissing", "core.db does not exist"])
	})
})
