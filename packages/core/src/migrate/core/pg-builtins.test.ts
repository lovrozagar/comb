import { describe, expect, it } from "vitest"
import { builtinFinding } from "./pg-builtins.ts"

/* plan 13: a call is rated from Postgres's parse tree, against the built-ins that write nothing */
describe("a Postgres function call", () => {
	it("is nothing for a pure built-in, with or without pg_catalog", () => {
		expect(builtinFinding(["lower"])).toBeUndefined()
		expect(builtinFinding(["pg_catalog", "now"])).toBeUndefined()
		expect(builtinFinding(["gen_random_uuid"])).toBeUndefined()
	})

	it("is cautious for setval, which sets a sequence as a RESTART does", () => {
		expect(builtinFinding(["setval"])).toEqual({ level: "cautious", note: "sets a sequence, as a RESTART does" })
	})

	it("is unsafe for dblink, which runs SQL comb cannot read, and for any other function", () => {
		expect(builtinFinding(["dblink"])?.note).toBe("calls dblink, which runs SQL comb cannot read")
		expect(builtinFinding(["dblink_exec"])?.level).toBe("unsafe")
		expect(builtinFinding(["purge"])).toEqual({ level: "unsafe", note: "calls purge, which comb cannot read" })
		/* a pure built-in's name in another schema is that schema's function */
		expect(builtinFinding(["app", "lower"])).toEqual({
			level: "unsafe",
			note: "calls app.lower, which comb cannot read",
		})
	})
})
