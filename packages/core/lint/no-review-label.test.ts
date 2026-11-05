import { describe, expect, it } from "vitest"
import plugin from "./index.js"
import { oxlintReports, reportsOf } from "./rule-harness.ts"

const rule = plugin.rules["no-review-label"]
const COMMENT = (label: string) =>
	`a shipped comment cites the review label "${label}"; say the reason, and keep the label in the commit`
const STRING = (label: string) =>
	`a shipped string cites the review label "${label}", which generated code or a message would carry`

describe("comb/no-review-label", () => {
	it("rejects a review label in a src comment, wrapped or bare", () => {
		const fixture = {
			"packages/core/src/a.ts": "/* the cap holds (KC2 of r22b) */\nexport const a = 1\n",
			"packages/core/src/b.ts": "// QL2 of area B round 3: the order\nexport const b = 1\n",
			"packages/core/src/c.ts": "/**\n * kept (KT7 of\n * r22b)\n */\nexport const c = 1\n",
			"packages/core/src/d.mjs": "// refused (U22)\nexport const d = 1\n",
			"packages/core/src/e.ts": "/* AB4-7 left it */\nexport const e = 1\n",
		}
		expect(reportsOf(rule, fixture)).toEqual(
			[
				["a.ts", "KC2 of r22b"],
				["b.ts", "QL2 of area B round 3"],
				["c.ts", "KT7 of r22b"],
				["d.mjs", "U22"],
				["e.ts", "AB4-7"],
			].map(([name, label]) => ({ file: `packages/core/src/${name}`, message: COMMENT(label!) })),
		)
	})

	it("rejects a review label in a src string or template, the JSDoc codegen emits", () => {
		const fixture = {
			"packages/core/src/a.ts": 'export const a = ["/** A cidr (F50, AA3) */"]\n',
			"packages/core/src/b.ts": "export const b = (x: string) => `/** ${x} (C5 of r19) */`\n",
		}
		expect(reportsOf(rule, fixture)).toEqual([
			{ file: "packages/core/src/a.ts", message: STRING("F50") },
			{ file: "packages/core/src/b.ts", message: STRING("C5 of r19") },
		])
	})

	it("leaves real names, doc sections, tests, fixtures and files outside src alone", () => {
		const fixture = {
			"packages/core/src/a.ts":
				"/* D1, FTS5, RE2, SHA256, ES2022, INT8 (P0001); see meta-contract §8.2 */\nexport const a = 'UTF8'\n",
			"packages/core/src/a.test.ts": "/* KC2 of r22b */\nexport const t = '(F50)'\n",
			"packages/core/tests/b.ts": "/* KC2 of r22b */\nexport const b = 1\n",
			"packages/core/src/cli/__fixtures__/c.ts": "/* KC2 of r22b */\nexport const c = 1\n",
		}
		expect(reportsOf(rule, fixture)).toEqual([])
	})

	it("fails oxlint through the comb plugin entry", () => {
		const fixture = {
			"packages/core/src/a.ts": "/* the cap (KC2 of r22b) */\nexport const a = 1\n",
			"packages/core/src/b.ts": "export const b = 1\n",
		}
		expect(oxlintReports("no-review-label", fixture)).toEqual([
			{ file: "packages/core/src/a.ts", message: COMMENT("KC2 of r22b") },
		])
	})
})
