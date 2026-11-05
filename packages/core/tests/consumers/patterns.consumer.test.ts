/**
 * The declared patterns comb takes compile on every Node comb supports. The consumers job runs this
 * file on Node's floor, where a construct only a newer ECMAScript reads, such as a modifier group or
 * a group name used twice, fails as the generated DTO module would when it loads (AA4-1 of r24).
 */
import { describe, expect, it } from "vitest"
import { patternLiteral } from "../../src/codegen/utils/pattern.ts"
import { PORTABLE_PATTERNS } from "../support/portable-patterns.ts"

describe("a pattern comb takes compiles on the Node running it (AA4-1)", () => {
	it("runs on Node, as the consumers job does", () => {
		expect(process.release.name).toBe("node")
		expect(process.versions.bun).toBeUndefined()
	})

	it.each(PORTABLE_PATTERNS)("compiles %s as the literal comb emits", (pattern) => {
		const literal = patternLiteral(pattern, "x")
		const regex = new Function(`return ${literal}`)() as RegExp
		expect(regex.flags).toBe("u")
	})
})
