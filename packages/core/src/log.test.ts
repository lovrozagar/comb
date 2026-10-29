import { afterEach, describe, expect, it, vi } from "vitest"
import { warnOnError } from "./log.ts"

afterEach(() => vi.restoreAllMocks())

/* K15 of r17: a failure a library absorbs reaches the console when its caller gave no log */
describe("warnOnError", () => {
	it("sends an *.error event to console.warn with its data, and drops every other event", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
		const data = { error: new Error("KV down"), orgId: "org-1" }
		warnOnError("shard-router.kv.error", data)
		warnOnError("shard-router.hit", { orgId: "org-1" })
		expect(warn.mock.calls).toEqual([["shard-router.kv.error", data]])
	})
})
