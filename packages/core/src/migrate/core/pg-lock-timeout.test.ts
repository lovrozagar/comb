import { describe, expect, it } from "vitest"
import { lockTimeoutMs } from "./pg-lock-timeout.ts"

describe("lockTimeoutMs", () => {
	it.each([
		["0", 0],
		["0s", 0],
		["250", 250],
		["5 s", 5000],
		["1.5s", 1500],
		["1500us", 2],
		["2500us", 2],
		["1499us", 1],
		["1min", 60_000],
		["1h", 3_600_000],
		["2147483647", 2_147_483_647],
		["1.5", 2],
		["2.5", 2],
	])("reads %j as %d milliseconds, rounding half to even as Postgres does", (text, ms) => {
		expect(lockTimeoutMs(text)).toBe(ms)
	})

	it.each(["soon", "-1s", "5S", "2147483648", "500us", "0.4", "1e3ms"])(
		"says why %j is none Postgres takes",
		(text) => {
			expect(typeof lockTimeoutMs(text)).toBe("string")
		},
	)
})
