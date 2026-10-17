import { describe, expect, it } from "vitest"
import plugin from "./index.js"
import { oxlintReports, reportsOf } from "./rule-harness.ts"

const rule = plugin.rules["no-v8-ignore"]
const MESSAGE = "coverage ignore hints are forbidden; delete the code or give it a case"

describe("comb/no-v8-ignore", () => {
	it("rejects every coverage-ignore hint the v8 provider honors", () => {
		const fixture = {
			"packages/core/src/a.ts": "/* v8 ignore next */\nexport const a = 1\n",
			"packages/core/src/b.ts": "// c8 ignore start\nexport const b = 1\n// c8 ignore stop\n",
			"packages/core/src/c.ts": "export const c = 1 /* istanbul ignore next */\n",
			"packages/core/lint/d.js": "/*   V8   IGNORE   else */\nexport const d = 1\n",
		}
		expect(reportsOf(rule, fixture)).toEqual([
			{ file: "packages/core/src/a.ts", message: MESSAGE },
			{ file: "packages/core/src/b.ts", message: MESSAGE },
			{ file: "packages/core/src/b.ts", message: MESSAGE },
			{ file: "packages/core/src/c.ts", message: MESSAGE },
			{ file: "packages/core/lint/d.js", message: MESSAGE },
		])
	})

	it("leaves ordinary comments that only mention coverage alone", () => {
		const fixture = {
			"packages/core/src/a.ts": "/* coverage is 100% here; nothing is ignored */\nexport const a = 1\n",
			"packages/core/src/b.ts": "// we never ignore v8 output\nexport const b = 1\n",
		}
		expect(reportsOf(rule, fixture)).toEqual([])
	})

	it("fails oxlint through the comb plugin entry", () => {
		const fixture = {
			"packages/core/src/a.ts": "/* v8 ignore next */\nexport const a = 1\n",
			"packages/core/src/b.ts": "export const b = 1\n",
		}
		expect(oxlintReports("no-v8-ignore", fixture)).toEqual([{ file: "packages/core/src/a.ts", message: MESSAGE }])
	})
})
