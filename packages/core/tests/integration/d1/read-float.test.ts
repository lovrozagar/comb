/**
 * 27.18 of plan 15 (F5 of the 0.14.1 review), on Miniflare's D1: D1 hands a stored ±Infinity back
 * as null, so a non-nullable float's read DTO takes the null its published schema promises, as it
 * takes the infinities a driver that reads them hands back.
 */
import * as z from "zod"
import { afterAll, afterEach, describe, expect, it } from "vitest"
import { type D1Harness, d1Memory } from "../support/d1.ts"
import { cleanGeneratedDtos, generatedDtos } from "../support/dtos.ts"

afterAll(() => cleanGeneratedDtos())

let harness: D1Harness | undefined
afterEach(async () => {
	await harness?.dispose()
	harness = undefined
})

describe("a non-nullable float stored as an infinity, read from D1", () => {
	it("reads as null, which the read DTO and its published schema both take", async () => {
		harness = await d1Memory()
		await harness.CORE.exec("CREATE TABLE gauge (id TEXT PRIMARY KEY, level REAL NOT NULL)")
		await harness.CORE.exec("INSERT INTO gauge VALUES ('gau_up', 9e999), ('gau_down', -9e999), ('gau_mid', 1.5)")
		const rows = (await harness.CORE.prepare("SELECT id, level FROM gauge ORDER BY id").all()).results
		expect(rows.map((row) => row["level"])).toEqual([null, 1.5, null])
		const dtos = await generatedDtos(
			"d1-read-float",
			`export const gauge = sqliteTable("gauge", { id: c.id("gau"), level: c.real("level").notNull() })`,
		)
		const read = dtos["gauge"]?.["gaugeDtoReadSchema"] as z.ZodObject
		for (const row of rows) expect(read.safeParse(row).success, String(row["id"])).toBe(true)
		const published = (z.toJSONSchema(read, { io: "output" }) as { properties: Record<string, { anyOf?: unknown }> })
			.properties["level"]
		expect(published?.anyOf).toEqual([{ type: "number" }, { type: "null" }])
	}, 60_000)
})
