/**
 * The 0.21 API item names what changed beyond declaration names (G1-1). Sibling:
 * upgrade-exports.test.ts, which holds the section's export lists to the exports.
 */
import { describe, expect, it } from "vitest"
import { section } from "./support/readme.ts"

/** The sentence of `text` that holds `marker` */
const sentence = (text: string, marker: string): string =>
	text.split(/(?<=\.) (?=[`A-Z*])/).find((part) => part.includes(marker)) ?? ""

describe("the 0.21 API item", () => {
	const upgrade = section("Upgrading to 0.21")

	it("names as changed in declaration names alone only what changed in them alone (G1-1)", () => {
		const names = sentence(upgrade, "changed only in the names their declarations give")
		expect(names).toContain("`ListQuerySchema`")
		expect(names).not.toContain("`createListQuerySchema`")
		expect(names).not.toContain("`queryHelpers`")
		const more = sentence(upgrade, "`createListQuerySchema` and `queryHelpers` change in those names")
		expect(more).toContain("`queryHelpers.filterValue` and `filterValues` take an `operator` (step 34)")
		expect(more).toContain("reserves `tiebreak`")
	})
})
