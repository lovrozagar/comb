import { describe, expect, it } from "vitest"
import { patternLiteral } from "./pattern.ts"

describe("patternLiteral: a pattern comb can emit and publish (F5, F6)", () => {
	it("writes a pattern back as a literal that compiles, a slash and a line terminator escaped", () => {
		expect(patternLiteral("/^a+$/", "x")).toBe("/^a+$/")
		expect(patternLiteral("/^a/b$/", "x")).toBe(String.raw`/^a\/b$/`)
		expect(patternLiteral(String.raw`/^a\/b$/`, "x")).toBe(String.raw`/^a\/b$/`)
		expect(patternLiteral("/^a\nb\u2028$/u", "x")).toBe(String.raw`/^a\nb\u2028$/u`)
		/* the engine's own source, which a regex in the tables file publishes as: a slash in a class stays */
		expect(patternLiteral("/^[A-Za-z_/]+$/", "x")).toBe("/^[A-Za-z_/]+$/")
		expect(patternLiteral("/[^/]/b/", "x")).toBe(String.raw`/[^/]\/b/`)
		for (const pattern of ["/^a+$/", "/^a/b$/", "/^a\nb$/", '/^[^"]+$/u'])
			expect(() => new Function(`return ${patternLiteral(pattern, "x")}`)()).not.toThrow()
	})

	it("refuses a value that is no /source/flags, naming the column", () => {
		for (const pattern of ["^[a-z]+$", "/", "//", "/a/B"])
			expect(() => patternLiteral(pattern, "t.name")).toThrow(
				/^t\.name: pattern .* is not a regex: write it as \/source\/flags$/,
			)
	})

	it("refuses every flag JSON Schema cannot publish, and takes u alone", () => {
		/* JSON Schema compiles a pattern under u, as Ajv does: a v source (set subtraction) does not compile there (F5) */
		for (const flag of ["i", "m", "s", "g", "y", "d", "v"])
			expect(() => patternLiteral(`/^a$/${flag}`, "t.code")).toThrow(
				/takes the flag .*, which JSON Schema cannot publish/,
			)
		expect(patternLiteral("/^a$/u", "x")).toBe("/^a$/u")
		expect(() => patternLiteral("/^[\\p{L}--[a-z]]+$/v", "t.name")).toThrow(
			"t.name: pattern /^[\\p{L}--[a-z]]+$/v takes the flag v, which JSON Schema cannot publish",
		)
	})

	it("refuses a source the engine cannot compile, with the engine's message", () => {
		expect(() => patternLiteral('/^[^\\"]+$/u', "t.q")).toThrow(
			/^t\.q: pattern .* does not compile: Invalid regular expression/,
		)
		expect(() => patternLiteral("/(/", "t.q")).toThrow(/does not compile/)
	})
})
