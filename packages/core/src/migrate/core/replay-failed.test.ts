import { describe, expect, it } from "vitest"
import { ReplayFailed } from "./replay-failed.ts"

describe("ReplayFailed", () => {
	it("is an Error named for what it is, keeping its cause", () => {
		const cause = new Error("dev refused")
		const failed = new ReplayFailed("nothing was compared", { cause })
		expect([failed instanceof Error, failed.name, failed.message, failed.cause]).toEqual([
			true,
			"ReplayFailed",
			"nothing was compared",
			cause,
		])
	})
})
