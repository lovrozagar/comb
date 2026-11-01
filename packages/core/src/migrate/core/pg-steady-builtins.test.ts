import { describe, expect, it } from "vitest"
import { STEADY_BUILTINS } from "./pg-steady-builtins.ts"

/* the whole list is regenerated and compared by tests/structure/pg-steady.test.ts, on Postgres 17 itself */
describe("STEADY_BUILTINS", () => {
	it("holds the IMMUTABLE and STABLE built-ins a default calls, and none that are VOLATILE", () => {
		for (const name of ["now", "timezone", "to_timestamp", "lower", "jsonb_build_object", "current_setting"])
			expect(STEADY_BUILTINS.has(name), name).toBe(true)
		for (const name of ["random", "clock_timestamp", "gen_random_uuid", "nextval", "timeofday", "int4in", ""])
			expect(STEADY_BUILTINS.has(name), name).toBe(false)
	})
})
