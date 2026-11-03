import { describe, expect, it } from "vitest"
import plugin from "./index.js"
import { oxlintReports, reportsOf } from "./rule-harness.ts"

const rule = plugin.rules["optional-undefined"]
const MESSAGE =
	"an optional property takes undefined, which comb reads as the key left out: declare it `name?: T | undefined`, a method as `name?: ((…) => R) | undefined`"

describe("comb/optional-undefined", () => {
	it("rejects an optional property, method or class field in core source whose type refuses undefined", () => {
		const fixture = {
			"packages/core/src/lru.ts": "export type LruOptions = { ttlMs?: number; max: number }\n",
			"packages/core/src/id.ts": "export interface UlidFactoryOptions { now?(): number }\n",
			"packages/core/src/query/types.ts": "export type Sort = { nulls?: 'first' | 'last' | null }\n",
			"packages/core/src/sqlite/d1/sharding/types.ts":
				"export class Pick { log?: (line: string) => void }\nexport const f = (o: { kv?: string[] }) => o\n",
		}
		expect(reportsOf(rule, fixture)).toEqual([
			{ file: "packages/core/src/lru.ts", message: MESSAGE },
			{ file: "packages/core/src/id.ts", message: MESSAGE },
			{ file: "packages/core/src/query/types.ts", message: MESSAGE },
			{ file: "packages/core/src/sqlite/d1/sharding/types.ts", message: MESSAGE },
			{ file: "packages/core/src/sqlite/d1/sharding/types.ts", message: MESSAGE },
		])
	})

	it("allows a type that takes undefined, an untyped field, a required property, tests and code outside src", () => {
		const fixture = {
			"packages/core/src/lru.ts":
				"export type LruOptions = { ttlMs?: number | undefined; now?: (() => number) | undefined; meta?: unknown; raw?: any; gone?: undefined; max: number }\n",
			"packages/core/src/sqlite/d1/sharding/types.ts": "export class Pick { log?; seen = 0 }\n",
			"packages/core/src/lru.test.ts": "export type T = { ttlMs?: number }\n",
			"scripts/verify.ts": "export type T = { ttlMs?: number }\n",
		}
		expect(reportsOf(rule, fixture)).toEqual([])
	})

	it("fails oxlint through the comb plugin entry", () => {
		const fixture = { "packages/core/src/lru.ts": "export type LruOptions = { ttlMs?: number }\n" }
		expect(oxlintReports("optional-undefined", fixture)).toEqual([
			{ file: "packages/core/src/lru.ts", message: MESSAGE },
		])
	})
})
