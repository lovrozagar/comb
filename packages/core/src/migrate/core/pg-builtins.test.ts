import { describe, expect, it } from "vitest"
import { builtinFinding } from "./pg-builtins.ts"

/* plan 13: a call is rated from Postgres's parse tree, against the built-ins that write nothing */
describe("a Postgres function call", () => {
	it("is nothing for a pure built-in, with or without pg_catalog", () => {
		expect(builtinFinding(["lower"], new Set())).toBeUndefined()
		expect(builtinFinding(["pg_catalog", "now"], new Set())).toBeUndefined()
		expect(builtinFinding(["gen_random_uuid"], new Set())).toBeUndefined()
	})

	it("is cautious for setval, which sets a sequence as a RESTART does", () => {
		expect(builtinFinding(["setval"], new Set())).toEqual({
			level: "cautious",
			note: "sets a sequence, as a RESTART does",
		})
	})

	it("is the migration's own for a name a migration defined, unless called by pg_catalog", () => {
		expect(builtinFinding(["lower"], new Set(["lower"]))).toEqual({
			level: "unsafe",
			note: "calls lower, a function a migration defined",
		})
		expect(builtinFinding(["public", "lower"], new Set(["lower"]))?.level).toBe("unsafe")
		expect(builtinFinding(["pg_catalog", "lower"], new Set(["lower"]))).toBeUndefined()
	})

	it("is unsafe for dblink, which runs SQL comb cannot read, and for any other function", () => {
		expect(builtinFinding(["dblink"], new Set())?.note).toBe("calls dblink, which runs SQL comb cannot read")
		expect(builtinFinding(["dblink_exec"], new Set())?.level).toBe("unsafe")
		expect(builtinFinding(["purge"], new Set())).toEqual({
			level: "unsafe",
			note: "calls purge, which comb cannot read",
		})
		/* a pure built-in's name in another schema is that schema's function */
		expect(builtinFinding(["app", "lower"], new Set())).toEqual({
			level: "unsafe",
			note: "calls app.lower, which comb cannot read",
		})
	})
})

/* M29 of the 0.13 review: what a call writes or copies out, rated as such */
describe("a Postgres call that advances a sequence or reads a setting", () => {
	it("is cautious for nextval, which a rollback does not undo, and unsafe for current_setting", () => {
		expect(builtinFinding(["nextval"], new Set())).toEqual({
			level: "cautious",
			note: "advances a sequence; a rollback does not undo it",
		})
		expect(builtinFinding(["current_setting"], new Set())?.level).toBe("unsafe")
		expect(builtinFinding(["currval"], new Set())).toBeUndefined()
		expect(builtinFinding(["lastval"], new Set())).toBeUndefined()
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
		expect(builtinFinding([name], new Set())).toBeUndefined()
	})
})
