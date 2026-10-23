import { describe, expect, it } from "vitest"
import plugin from "./index.js"
import { oxlintReports, reportsOf } from "./rule-harness.ts"

const rule = plugin.rules["raw-sql-allowlist"]
const PLACE = "sql.raw belongs to query/sqlite/{search,keyset,filter-sql}.ts; build the query with sql``"
const ARG = "sql.raw takes a string literal, a ternary of string literals, quoteIdent(…) or countText(…)"

describe("comb/raw-sql-allowlist", () => {
	it("rejects sql.raw outside the three query builders, called or passed around", () => {
		const fixture = {
			"packages/core/src/query/filter.ts": 'export const a = sql.raw("x")\n',
			"packages/core/src/sqlite/patterns.ts": "export const r = sql.raw\n",
			"packages/core/src/pg/columns.ts": "export const c = (n: string) => sql.raw(quoteIdent(n))\n",
		}
		expect(reportsOf(rule, fixture)).toEqual([
			{ file: "packages/core/src/query/filter.ts", message: PLACE },
			{ file: "packages/core/src/sqlite/patterns.ts", message: PLACE },
			{ file: "packages/core/src/pg/columns.ts", message: PLACE },
		])
	})

	it("rejects an argument that is not a literal, a ternary of literals, or quoteIdent", () => {
		const fixture = {
			"packages/core/src/query/sqlite/search.ts": "export const t = (name: string) => sql.raw(name)\n",
			"packages/core/src/query/sqlite/filter-sql.ts":
				"export const c = (a: string, b: string) => sql.raw(`${a}.${b}`)\n",
			"packages/core/src/query/sqlite/keyset.ts":
				'export const d = (asc: boolean, x: string) => sql.raw(asc ? "ASC" : x)\nexport const e = () => sql.raw()\nexport const f = (n: number) => sql.raw(String(n))\n',
		}
		expect(reportsOf(rule, fixture)).toEqual([
			{ file: "packages/core/src/query/sqlite/search.ts", message: ARG },
			{ file: "packages/core/src/query/sqlite/filter-sql.ts", message: ARG },
			{ file: "packages/core/src/query/sqlite/keyset.ts", message: ARG },
			{ file: "packages/core/src/query/sqlite/keyset.ts", message: ARG },
			{ file: "packages/core/src/query/sqlite/keyset.ts", message: ARG },
		])
	})

	it("allows literals, ternaries of literals, quoteIdent and countText in the allowlisted files", () => {
		const fixture = {
			"packages/core/src/query/sqlite/keyset.ts": [
				'export const d = (asc: boolean) => sql.raw(asc ? "ASC" : "DESC")',
				'export const n = (f: boolean, l: boolean) => sql.raw(f ? "NULLS FIRST" : l ? "NULLS LAST" : `NULLS DEFAULT`)',
				"export const s = () => sql.raw(`SELECT 1`)",
				"export const c = (n: number) => sql.raw(countText(n))",
				"",
			].join("\n"),
			"packages/core/src/query/sqlite/search.ts":
				"export const t = (name: string) => sql.raw(quoteIdent(name))\nexport const q = (o: { raw(): void }) => o.raw()\n",
			"packages/core/src/query/sqlite/search.test.ts": "sql.raw(anything)\n",
			"packages/core/tests/integration/sqlite/x.test.ts": "sql.raw(anything)\n",
		}
		expect(reportsOf(rule, fixture)).toEqual([])
	})

	it("fails oxlint through the comb plugin entry", () => {
		const fixture = {
			"packages/core/src/query/sqlite/search.ts": "export const t = (name: string) => sql.raw(name)\n",
			"packages/core/src/query/sqlite/keyset.ts": 'export const d = () => sql.raw("ASC")\n',
		}
		expect(oxlintReports("raw-sql-allowlist", fixture)).toEqual([
			{ file: "packages/core/src/query/sqlite/search.ts", message: ARG },
		])
	})
})
