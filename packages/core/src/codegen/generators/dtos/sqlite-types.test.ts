/* A2-12 of r22: a plain SQLite numeric takes at most the 15 digits SQLite's NUMERIC keeps */
import * as z from "zod"
import { describe, expect, it } from "vitest"
import { parseField } from "../../__fixtures__/runtime.ts"
import { SQLITE_NUMERIC, sqliteWriteRule } from "./sqlite-types.ts"

const numeric = new Function("z", `return ${SQLITE_NUMERIC}`)(z) as z.ZodType
const takes = (value: string) => numeric.safeParse(value).success

describe("sqliteWriteRule", () => {
	it("gives a plain numeric its digits rule, and no other plain type a rule", () => {
		expect(sqliteWriteRule(parseField("n", 'numeric("n")'))).toBe(SQLITE_NUMERIC)
		expect(sqliteWriteRule(parseField("n", 'text("n")'))).toBeUndefined()
	})

	it("takes 15 digits split anywhere about the point, and refuses 16", () => {
		for (let whole = 1; whole <= 15; whole++) {
			const fraction = 15 - whole
			const kept = `${"7".repeat(whole)}${fraction === 0 ? "" : `.${"7".repeat(fraction)}`}`
			expect([takes(kept), takes(`-${kept}`), takes(`000${kept}`)], kept).toEqual([true, true, true])
			expect([takes(`7${kept}`), fraction !== 0 && takes(`${kept}7`)], `${kept} and one more`).toEqual([false, false])
		}
		/* a whole part of 0 costs no digit */
		expect([takes(`0.${"7".repeat(15)}`), takes(`0.${"7".repeat(16)}`)]).toEqual([true, false])
	})

	it("refuses a spelling SQLite reads as a number, or as text", () => {
		for (const value of ["1e3", "+3", " 12", ".5", "1.", "-", "0x10", "", "1.2.3"])
			expect(takes(value), value).toBe(false)
	})
})
