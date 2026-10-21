import { describe, expect, it } from "vitest"
import { Refused } from "./refused.ts"

describe("Refused", () => {
	it("is an Error carrying its message and a copy of the pending files", () => {
		const pending = ["1.sql", "2.sql"]
		const refused = new Refused("2.sql is unsafe", pending)
		pending.push("3.sql")
		expect(refused).toBeInstanceOf(Error)
		expect([refused.name, refused.message, refused.pending]).toEqual(["Refused", "2.sql is unsafe", ["1.sql", "2.sql"]])
	})
})
