import { describe, expect, it } from "vitest"
import { builtinFinding } from "./pg-builtins.ts"

/** The history's facts a call is rated against: the functions it defined, keyed under `schema` */
const at = (defined: string[] = [], schema = "public") => ({ defined: new Set(defined), schema })

/* plan 13: a call is rated from Postgres's parse tree, against the built-ins that write nothing */
describe("a Postgres function call", () => {
	it("is nothing for a pure built-in, with or without pg_catalog", () => {
		expect(builtinFinding(["lower"], at())).toBeUndefined()
		expect(builtinFinding(["pg_catalog", "now"], at())).toBeUndefined()
		expect(builtinFinding(["gen_random_uuid"], at())).toBeUndefined()
	})

	it("is cautious for setval, which sets a sequence as a RESTART does", () => {
		expect(builtinFinding(["setval"], at())).toEqual({
			level: "cautious",
			note: "sets a sequence, as a RESTART does",
		})
	})

	it("is the migration's own for a name a migration defined, unless called by pg_catalog", () => {
		expect(builtinFinding(["lower"], at(["lower"]))).toEqual({
			level: "unsafe",
			note: "calls lower, a function a migration defined",
		})
		expect(builtinFinding(["public", "lower"], at(["lower"]))?.level).toBe("unsafe")
		expect(builtinFinding(["pg_catalog", "lower"], at(["lower"]))).toBeUndefined()
	})

	it("is unsafe for dblink, which runs SQL comb cannot read, and for any other function", () => {
		expect(builtinFinding(["dblink"], at())?.note).toBe("calls dblink, which runs SQL comb cannot read")
		expect(builtinFinding(["dblink_exec"], at())?.level).toBe("unsafe")
		expect(builtinFinding(["purge"], at())).toEqual({
			level: "unsafe",
			note: "calls purge, which comb cannot read",
		})
		/* M90: only pg_catalog names the built-in; public.lower is a function of public's, from outside the history */
		expect(builtinFinding(["public", "lower"], at())).toEqual({
			level: "unsafe",
			note: "calls public.lower, which comb cannot read",
		})
		/* a call qualified by the target's schema names the function a migration defined there */
		expect(builtinFinding(["app", "f"], at(["f"], "app"))?.note).toBe("calls app.f, a function a migration defined")
		/* one defined in another schema is keyed with it; a name of three parts is never the target's */
		expect(builtinFinding(["other", "f"], at(["other.f"]))?.note).toBe("calls other.f, a function a migration defined")
		expect(builtinFinding(["db", "app", "f"], at(["f"], "app"))?.note).toBe("calls db.app.f, which comb cannot read")
		/* a pure built-in's name in another schema is that schema's function */
		expect(builtinFinding(["app", "lower"], at())).toEqual({
			level: "unsafe",
			note: "calls app.lower, which comb cannot read",
		})
	})
})

/* M29 of the 0.13 review: what a call writes or copies out, rated as such */
describe("a Postgres call that advances a sequence or reads a setting", () => {
	it("is cautious for nextval, which a rollback does not undo, and unsafe for current_setting", () => {
		expect(builtinFinding(["nextval"], at())).toEqual({
			level: "cautious",
			note: "advances a sequence; a rollback does not undo it",
		})
		expect(builtinFinding(["current_setting"], at())?.level).toBe("unsafe")
		expect(builtinFinding(["currval"], at())).toBeUndefined()
		expect(builtinFinding(["lastval"], at())).toBeUndefined()
	})
})

/* M30 of the 0.13 review: the side-effect-free built-ins a backfill uses */
describe("a Postgres backfill's common pure built-ins", () => {
	it.each([
		"row_number",
		"rank",
		"dense_rank",
		"lag",
		"lead",
		"first_value",
		"last_value",
		"ntile",
		"position",
		"overlay",
		"string_to_table",
		"regexp_like",
		"sha256",
		"ln",
		"log",
		"exp",
		"pi",
		"div",
		"array_upper",
		"jsonb_path_query_first",
		"to_regclass",
		"date_bin",
	])("is nothing for %s", (name) => {
		expect(builtinFinding([name], at())).toBeUndefined()
	})
})
