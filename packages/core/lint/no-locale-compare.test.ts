import { describe, expect, it } from "vitest"
import plugin from "./index.js"
import { oxlintReports, reportsOf } from "./rule-harness.ts"

const rule = plugin.rules["no-locale-compare"]
const MESSAGE =
	"localeCompare orders by the machine's locale, so output differs between machines; compare with byCodeUnit from src/codegen/utils/order.ts"

describe("comb/no-locale-compare", () => {
	it("rejects localeCompare in core source, called or passed, by name or by string", () => {
		const fixture = {
			"packages/core/src/codegen/runtime/to-meta.ts":
				"export const s = (x: string[]) => x.sort((a, b) => a.localeCompare(b))\n",
			"packages/core/src/cli/codegen-record.ts": 'export const f = (a: string, b: string) => a["localeCompare"](b)\n',
		}
		expect(reportsOf(rule, fixture)).toEqual([
			{ file: "packages/core/src/codegen/runtime/to-meta.ts", message: MESSAGE },
			{ file: "packages/core/src/cli/codegen-record.ts", message: MESSAGE },
		])
	})

	it("allows tests, code outside src, and a property of another name", () => {
		const fixture = {
			"packages/core/src/codegen/runtime/to-meta.test.ts": 'export const n = "a".localeCompare("b")\n',
			"scripts/verify.ts": 'export const n = "a".localeCompare("b")\n',
			"packages/core/src/codegen/utils/order.ts": "export const n = (x: { compare: number }) => x.compare\n",
		}
		expect(reportsOf(rule, fixture)).toEqual([])
	})

	it("fails oxlint through the comb plugin entry", () => {
		const fixture = { "packages/core/src/codegen/generators/relations.ts": 'export const n = "a".localeCompare("b")\n' }
		expect(oxlintReports("no-locale-compare", fixture)).toEqual([
			{ file: "packages/core/src/codegen/generators/relations.ts", message: MESSAGE },
		])
	})
})
