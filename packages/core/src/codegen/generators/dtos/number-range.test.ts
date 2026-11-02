import { describe, expect, it } from "vitest"
import { parseField } from "../../__fixtures__/runtime.ts"
import { numberRules } from "./number-range.ts"

const SAFE = { max: Number.MAX_SAFE_INTEGER, min: Number.MIN_SAFE_INTEGER }

/* C2 of r20: the bounds a written number takes, which the manifest states as the DTO checks them */
describe("numberRules", () => {
	it.each([
		{ dialect: "sqlite", name: "a boolean", raw: 'c.boolean("f")', rules: { max: null, min: null } },
		{ dialect: "sqlite", name: "a timestamp comb fills", raw: 'c.createdAt("f")', rules: { max: null, min: null } },
		{ dialect: "sqlite", name: "a written timestamp, a JS number's exact range", raw: 'c.timestamp("f")', rules: SAFE },
		{
			dialect: "sqlite",
			name: "an integer on sqlite, its declared max",
			raw: 'c.integer("f", { max: 9 })',
			rules: { max: 9, min: SAFE.min },
		},
		{
			dialect: "postgres",
			name: "an integer on postgres, in int4",
			raw: 'c.integer("f", { min: 0 })',
			rules: { max: 2147483647, min: 0 },
		},
		{
			dialect: "postgres",
			name: "an integer's declared bound past int4, clamped",
			raw: 'c.integer("f", { max: 1e12 })',
			rules: { max: 2147483647, min: -2147483648 },
		},
		{
			dialect: "sqlite",
			name: "a float, as declared",
			raw: 'c.real("f", { min: 0.5 })',
			rules: { max: null, min: 0.5 },
		},
	] as const)("$name", ({ dialect, raw, rules }) => {
		expect(numberRules(parseField("f", raw, { dialect }), dialect)).toEqual(rules)
	})
})
