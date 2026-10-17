import { describe, expect, it } from "vitest"
import plugin from "./index.js"
import { oxlintReports, reportsOf } from "./rule-harness.ts"

const rule = plugin.rules["no-module-state"]
const MESSAGE =
	"module-scope state needs `// <reason>: <why>` on its line or the line above, with reason lookup-table, lru-cache or per-process-constant"

describe("comb/no-module-state", () => {
	it("rejects module-scope let, var and constructed state", () => {
		const fixture = {
			"packages/core/src/a.ts": "let count = 0\nexport function bump() {\n\treturn ++count\n}\n",
			"packages/core/src/b.ts": "export var cache = {}\n",
			"packages/core/src/c.ts":
				"const seen = new Map<string, number>()\nexport const has = (k: string) => seen.has(k)\n",
			"packages/core/src/codegen/d.ts": "export const memo = new WeakMap() as WeakMap<object, string>\n",
		}
		expect(reportsOf(rule, fixture)).toEqual([
			{ file: "packages/core/src/a.ts", message: MESSAGE },
			{ file: "packages/core/src/b.ts", message: MESSAGE },
			{ file: "packages/core/src/c.ts", message: MESSAGE },
			{ file: "packages/core/src/codegen/d.ts", message: MESSAGE },
		])
	})

	it("accepts an allowlisted reason with an explanation on the line or the line above", () => {
		const fixture = {
			"packages/core/src/codegen/diagrams.ts":
				"const COMMON = new Set(['id']) // lookup-table: columns every table carries\n",
			"packages/core/src/query/cache.ts":
				"// lru-cache: compiled filters, bounded at 256\nconst compiled = new Map()\nexport const get = (k: string) => compiled.get(k)\n",
			"packages/core/src/id.ts":
				"const encoder = new TextEncoder() // per-process-constant: stateless codec\nexport const e = encoder\n",
		}
		expect(reportsOf(rule, fixture)).toEqual([])
	})

	it("rejects a reason that is not on the allowlist, or one without an explanation", () => {
		const fixture = {
			"packages/core/src/a.ts": "let n = 0 // convenient: shared counter\nexport const get = () => n\n",
			"packages/core/src/b.ts": "// lookup-table:\nconst m = new Map()\nexport const get = () => m\n",
			"packages/core/src/c.ts": "// lru-cache\nconst m = new Map()\nexport const get = () => m\n",
		}
		expect(reportsOf(rule, fixture)).toEqual([
			{ file: "packages/core/src/a.ts", message: MESSAGE },
			{ file: "packages/core/src/b.ts", message: MESSAGE },
			{ file: "packages/core/src/c.ts", message: MESSAGE },
		])
	})
})

describe("comb/no-module-state: scope", () => {
	it("allows constants, function-scope state, tests and code outside src", () => {
		const fixture = {
			"packages/core/src/a.ts":
				"const LIMIT = 10\nconst NAMES = ['a', 'b'] as const\nexport function f() {\n\tlet i = 0\n\tconst m = new Map()\n\treturn m.size + i + LIMIT + NAMES.length\n}\n",
			"packages/core/src/a.test.ts": "let calls = 0\nconst m = new Map()\n",
			"scripts/verify.ts": "let failed = false\n",
		}
		expect(reportsOf(rule, fixture)).toEqual([])
	})

	it("fails oxlint through the comb plugin entry", () => {
		const fixture = {
			"packages/core/src/a.ts": "let n = 0\nexport const get = () => n\n",
			"packages/core/src/b.ts":
				"const enc = new TextEncoder() // per-process-constant: stateless codec\nexport const e = enc\n",
		}
		expect(oxlintReports("no-module-state", fixture)).toEqual([{ file: "packages/core/src/a.ts", message: MESSAGE }])
	})
})
