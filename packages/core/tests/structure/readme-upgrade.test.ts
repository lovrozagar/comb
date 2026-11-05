/**
 * The 0.21 API item names what changed beyond declaration names (G1-1), the fields it made required
 * (G1-2), both keys a list's extras gain (G1-3) and the D1 fake that `withSession` as a property
 * refuses (G1-4). Sibling: upgrade-exports.test.ts, which holds the section's export lists to the
 * exports.
 */
import { describe, expect, it } from "vitest"
import { section } from "./support/readme.ts"

/** The sentence of `text` that holds `marker` */
const sentence = (text: string, marker: string): string =>
	text.split(/(?<=\.) (?=[`A-Z*])/).find((part) => part.includes(marker)) ?? ""

/** The paragraph of `text` that holds `marker` */
const paragraph = (text: string, marker: string): string =>
	text.split("\n\n").find((part) => part.includes(marker)) ?? ""

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

	it("calls the fields a ManifestColumn or DecodedCursor requires breaking, with a fix (G1-2)", () => {
		const manifest = paragraph(upgrade, "`ManifestColumn` gains `sqlType`")
		expect(manifest).not.toContain("additive")
		expect(manifest).toContain("fails to compile (TS2741)")
		expect(manifest).toContain("**Fix:** a `ManifestColumn` you build sets `sqlType`, `dimensions` and `nullElements`")
		expect(paragraph(upgrade, "`FieldMeta` gains an optional `nullElements`")).not.toContain(
			"`ManifestColumn` and `FieldMeta` gain",
		)
		const cursor = paragraph(upgrade, "`DecodedCursor.carried`")
		expect(cursor).toContain("fails to compile (TS2741)")
		expect(cursor).toContain("**Fix:** a `DecodedCursor` you build sets `carried`, one boolean per sort value")
	})

	it("names both keys ListExtra and ListExtras gain (G1-3)", () => {
		expect(upgrade).toContain("`ListExtra` and `ListExtras` gain `_combKeyTexts` and `_combTextKeys` (steps 60, 63)")
	})

	it("names the D1 fake D1DatabaseLike.withSession, a property now, refuses (G1-4)", () => {
		const property = paragraph(upgrade, "`D1DatabaseLike.withSession` is a property now")
		expect(property).toContain("Every optional property comb declares takes `undefined`")
		expect(property).toContain("**Fix:** a D1 fake's `withSession` takes `string | undefined`")
	})
})
