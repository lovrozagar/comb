import { describe, expect, it } from "vitest"
import { NOT_COMPARED, UNCOMPARED } from "./baseline-uncompared.ts"
import { CATALOG } from "./pg-live-catalog.ts"

/* P12 of r19: the warning is written from one list, and names nothing the catalog read compares */
describe("UNCOMPARED and NOT_COMPARED", () => {
	it("is the list, whole, in one sentence", () => {
		for (const kind of NOT_COMPARED) expect(UNCOMPARED).toContain(kind)
		expect(UNCOMPARED).toMatch(/^Warning: .* are not compared$/)
	})

	it("names no kind the catalog read labels", () => {
		const labels = [...CATALOG.matchAll(/SELECT '(?:other|platform)', '([a-z ]+?) '/g)].map(
			(match) => match[1] as string,
		)
		expect(labels.length).toBeGreaterThan(0)
		/* each item of the list, as a whole, is never one of the compared kinds; "triggers' WHEN clauses" is a part of one */
		const items = NOT_COMPARED.flatMap((kind) => kind.split(/, | and /))
		const compared = [...labels, "routine", "trigger", "policy", "rule", "extension", "sequence", "materialized view"]
		for (const label of compared) expect([label, items.filter((item) => item === `${label}s`)]).toEqual([label, []])
	})
})
