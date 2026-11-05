/**
 * The README's newest upgrade section tells a project what to do for each change it lists: every  *
 * item, and every paragraph of a long item past its title, carries a **Fix:** label, `none` where
 * * nothing needs doing (G1-6). The API item's lists of new and changed exports are exempt, as the
 * * paragraphs after them carry the fixes. The 0.21 API item names what changed beyond declaration
 * names (G1-1), the fields it made required (G1-2), both keys a list's extras gain (G1-3) and the
 * D1 fake that `withSession` as a property refuses (G1-4). Sibling: upgrade-exports.test.ts, which
 * holds the section's export lists to the exports.
 */
import { describe, expect, it } from "vitest"
import { README, section } from "./support/readme.ts"

/** The paragraphs of `text`'s numbered items, each by its first words, that carry no **Fix:** label */
function unfixed(text: string): string[] {
	const paragraphs = text.split("\n\n").map((paragraph) => paragraph.replace(/^\n+/, ""))
	return paragraphs
		.filter((paragraph, at) => {
			const item = /^\d+\. /.test(paragraph)
			if (!item && !paragraph.startsWith("   ")) return false
			if (item && paragraphs[at + 1]?.startsWith("   ")) return false
			if (/^ {3}(New exports|Changed): /.test(paragraph)) return false
			return !paragraph.includes("**Fix:**")
		})
		.map((paragraph) => paragraph.trim().slice(0, 60))
}

/** The sentence of `text` that holds `marker` */
const sentence = (text: string, marker: string): string =>
	text.split(/(?<=\.) (?=[`A-Z*])/).find((part) => part.includes(marker)) ?? ""

/** The paragraph of `text` that holds `marker` */
const paragraph = (text: string, marker: string): string =>
	text.split("\n\n").find((part) => part.includes(marker)) ?? ""

describe("the paragraphs of an upgrade item without a Fix label", () => {
	const text = [
		"1. **Know the API.** Lists follow.",
		"   New exports: `a`.",
		"   Changed: `b`.",
		"   `b` takes more. **Fix:** pass it.",
		"   `c` is faster.",
		"2. **Run more.** It runs. **Fix:** none.",
		"3. **Read less.** It reads less.",
		"Prose after the list.",
	].join("\n\n")

	it("are each item and part with none, past a long item's title and its two export lists", () => {
		expect(unfixed(text)).toEqual(["`c` is faster.", "3. **Read less.** It reads less."])
	})
})

describe("the newest upgrade section (G1-6)", () => {
	const heading = /\n## (Upgrading to [^\n]+)\n/.exec(README)?.[1] ?? ""
	const upgrade = section(heading)

	it("gives every item, and every part of a long one, a Fix label", () => {
		expect(upgrade).toMatch(/^1\. \*\*/m)
		expect(unfixed(upgrade), `paragraphs of "${heading}" without **Fix:**`).toEqual([])
	})
})

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
