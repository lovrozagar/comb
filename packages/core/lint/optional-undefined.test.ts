import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import plugin from "./index.js"
import { TAKEN_BACK } from "./optional-undefined.js"
import { oxlintReports, reportsOf } from "./rule-harness.ts"

const rule = plugin.rules["optional-undefined"]
const MESSAGE =
	"an optional property takes undefined, which comb reads as the key left out: declare it `name?: T | undefined`, a method as `name?: ((…) => R) | undefined`"
const PARTIAL =
	"a Partial<…> that comb reads refuses undefined, which comb reads as the key left out: declare the input `{ [K in …]?: T | undefined }`; Partial<…> is for what comb hands back, in a return type or an alias only return types reach"

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

describe("comb/optional-undefined on Partial<…>", () => {
	it("rejects a Partial<…> a parameter or a config property reaches, an input bag that refuses undefined", () => {
		const fixture = {
			"packages/core/src/cli/output.ts":
				"type Terminal = { input: string; output: string }\nexport function processIo({ input }: Partial<Terminal> = {}) { return input }\n",
			"packages/core/src/codegen/config.ts":
				"export type CodegenConfig = { output?: Partial<Record<'zod' | 'default', string>> | undefined }\n",
			"packages/core/src/states.ts":
				"export interface StateMachine { transitions?: Readonly<Partial<Record<string, string[]>>> | undefined }\nexport class Seen { last: Partial<{ at: number }> = {} }\n",
		}
		expect(reportsOf(rule, fixture)).toEqual([
			{ file: "packages/core/src/cli/output.ts", message: PARTIAL },
			{ file: "packages/core/src/codegen/config.ts", message: PARTIAL },
			{ file: "packages/core/src/states.ts", message: PARTIAL },
			{ file: "packages/core/src/states.ts", message: PARTIAL },
		])
	})

	it("allows a Partial<…> comb hands back: a return type, its own value, a callback's parameter, an alias only those reach", () => {
		const fixture = {
			"packages/core/src/query/list.ts": [
				"type Extras = Partial<{ total: number }>",
				"export type ListResult = { rows: string[]; extras: Extras }",
				"export function list(): ListResult { return { rows: [] } }",
				"export const pick = (): Partial<{ a: number }> => ({})",
				"const seen: Partial<{ a: number }> = {}",
				"export const cast = {} as Partial<{ a: number }>",
				"export const fill = new Map<string, Partial<{ a: number }>>()",
				"export function apply(select: (extras: Extras) => void) { select({}) }",
				"export type ListOptions = { select: (extras: Partial<{ a: number }>) => void }",
				"export function listWith(options: ListOptions) { options.select({}) }",
				"",
			].join("\n"),
		}
		expect(reportsOf(rule, fixture)).toEqual([])
	})

	it("follows an alias across src files: one only another file's return type reaches passes, one a parameter reaches fails", () => {
		const fixture = {
			"packages/core/src/query/shapes.ts":
				"export type Extras = Partial<{ total: number }>\nexport type Limits = Partial<{ max: number }>\n",
			"packages/core/src/query/list.ts":
				"import type { Extras, Limits } from './shapes.ts'\nexport function list(limits: Limits): Extras { return {} }\n",
		}
		expect(oxlintReports("optional-undefined", fixture)).toEqual([
			{ file: "packages/core/src/query/shapes.ts", message: PARTIAL },
		])
	})
})

describe("comb/optional-undefined on what comb takes back", () => {
	it("takes back only the outputs TAKEN_BACK names, each one a Partial<…> alias src still declares", () => {
		const fixture = {
			"packages/core/src/query/sqlite/build-list-query-types.ts":
				"type ListExtras = Partial<{ _total: number }>\nexport type ListQueryResult = { extras: ListExtras }\nexport function build(): ListQueryResult { return { extras: {} } }\nexport function apply(q: ListQueryResult) { return q.extras }\nexport type Limits = Partial<{ max: number }>\nexport function list(): Limits { return {} }\nexport function read(limits: Limits) { return limits }\n",
		}
		expect(reportsOf(rule, fixture)).toEqual([
			{ file: "packages/core/src/query/sqlite/build-list-query-types.ts", message: PARTIAL },
		])
		const src = join(import.meta.dirname, "..", "src")
		const declared = readdirSync(src, { encoding: "utf8", recursive: true })
			.filter((file) => file.endsWith(".ts"))
			.flatMap((file) => [...readFileSync(join(src, file), "utf8").matchAll(/type (\w+) = Partial</g)].map((m) => m[1]))
		for (const name of TAKEN_BACK.keys()) expect(declared).toContain(name)
	})
})
