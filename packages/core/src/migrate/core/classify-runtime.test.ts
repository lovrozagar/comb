import { describe, expect, it } from "vitest"
import { preparedOf, runtimeFindings } from "./classify-runtime.ts"

const none = () => []

describe("preparedOf", () => {
	it("reads each prepared statement's name and the code it runs", () => {
		expect([...preparedOf(['PREPARE "s" (int) AS DELETE FROM t WHERE id = $1', "SELECT 1"])]).toEqual([
			["s", "DELETE FROM t WHERE id = $1"],
		])
	})
})

describe("runtimeFindings", () => {
	it("reads an EXECUTE as what it runs, and one comb cannot read as cautious", () => {
		const prepared = new Map([["s", "DELETE FROM t"]])
		expect(runtimeFindings("EXECUTE s", prepared, () => [{ level: "unsafe" }])).toEqual([{ level: "unsafe" }])
		expect(runtimeFindings("EXECUTE other", prepared, none)).toEqual([
			{ level: "cautious", note: "runs a prepared statement comb cannot read" },
		])
	})

	it("rates a pragma by name: comb's own nothing, writable_schema unsafe, any other cautious", () => {
		expect(runtimeFindings("PRAGMA main.defer_foreign_keys = on", new Map(), none)).toEqual([])
		expect(runtimeFindings("PRAGMA WRITABLE_SCHEMA = 1", new Map(), none)[0]?.level).toBe("unsafe")
		expect(runtimeFindings("PRAGMA recursive_triggers = on", new Map(), none)[0]?.level).toBe("cautious")
	})
})
