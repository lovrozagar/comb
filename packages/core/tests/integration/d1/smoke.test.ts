import { afterEach, describe, expect, it } from "vitest"
import { type D1Harness, d1Memory } from "../support/d1.ts"

describe("miniflare D1 harness", () => {
	let harness: D1Harness | undefined

	afterEach(async () => {
		await harness?.dispose()
		harness = undefined
	})

	it("runs prepared statements on the CORE database", async () => {
		harness = await d1Memory()
		await harness.CORE.exec("CREATE TABLE note (id integer PRIMARY KEY, body text NOT NULL)")
		await harness.CORE.batch([
			harness.CORE.prepare("INSERT INTO note (id, body) VALUES (?, ?)").bind(1, "a"),
			harness.CORE.prepare("INSERT INTO note (id, body) VALUES (?, ?)").bind(2, "b"),
		])
		const { results } = await harness.CORE.prepare("SELECT id, body FROM note ORDER BY id").all()
		expect(results).toEqual([
			{ body: "a", id: 1 },
			{ body: "b", id: 2 },
		])
	})

	it("reports engine errors the way D1 does", async () => {
		harness = await d1Memory()
		await harness.CORE.exec("CREATE TABLE u (email text UNIQUE)")
		await harness.CORE.prepare("INSERT INTO u VALUES ('x')").run()
		await expect(harness.CORE.prepare("INSERT INTO u VALUES ('x')").run()).rejects.toThrow(
			/UNIQUE constraint failed: u\.email/,
		)
	})

	it("binds a KV namespace and gives every harness fresh storage", async () => {
		harness = await d1Memory()
		await harness.KV.put("shard:org_1", "core-2")
		expect(await harness.KV.get("shard:org_1")).toBe("core-2")
		await harness.dispose()
		harness = await d1Memory()
		expect(await harness.KV.get("shard:org_1")).toBeNull()
	})
})
