/// <reference types="bun-types" />
/* bun's suites run in UTC, as CI's runners are, whatever the shell's TZ (bunfig.toml's preload) */
import { describe, expect, it } from "bun:test"

describe("the time zone bun's suites run in", () => {
	it("is UTC", () => {
		expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe("UTC")
		expect(new Date(2000, 0, 1).getTimezoneOffset()).toBe(0)
	})
})
