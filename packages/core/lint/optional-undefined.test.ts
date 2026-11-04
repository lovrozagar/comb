import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import plugin from "./index.js"
import { TAKEN_BACK } from "./optional-undefined.js"
import { oxlintReports, reportsOf, reportsOnDisk } from "./rule-harness.ts"

const rule = plugin.rules["optional-undefined"]
const MESSAGE =
	"an optional property takes undefined, which comb reads as the key left out: declare it `name?: T | undefined`, a method as `name?: ((…) => R) | undefined`"
const MAPPED =
	"an optional mapped key takes undefined, which comb reads as the key left out: declare it `{ [K in …]?: T | undefined }`"
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
		/* in process too, where each file reads the others from disk and its own as it is handed */
		expect(reportsOnDisk(rule, fixture)).toEqual([{ file: "packages/core/src/query/shapes.ts", message: PARTIAL }])
	})

	it("follows a cycle of aliases once, to the input that reaches it", () => {
		expect(
			lint("type A = { p: Partial<{ a: number }>; b: B }\ntype B = { a: A }\nexport function f(b: B) { return b }\n"),
		).toEqual([{ file: at, message: PARTIAL }])
	})
})

/* D2-6 of the area D round-two review: the shapes L1 to L5 its probe found, each with its control */
const at = "packages/core/src/query/probe.ts"
const lint = (source: string) => reportsOf(rule, { [at]: source })

describe("comb/optional-undefined through a generic alias", () => {
	it("reads a Partial<…> in a generic alias's type argument the way that alias's parameter flows (L1, L2)", () => {
		const setter = "type Setter<T> = (value: T) => void\n"
		expect(
			lint(`${setter}export function make(): Setter<Partial<{ a: number }>> { return (v) => void v.a }\n`),
		).toEqual([{ file: at, message: PARTIAL }])
		expect(lint(`${setter}export function on(listener: Setter<Partial<{ a: number }>>) { listener({}) }\n`)).toEqual([])
		/* a parameter one alias passes to another flows as the inner one's does */
		const wrap = `${setter}type Wrap<U> = { set: Setter<U> }\n`
		expect(lint(`${wrap}export function make(): Wrap<Partial<{ a: number }>> { return { set: () => {} } }\n`)).toEqual([
			{ file: at, message: PARTIAL },
		])
		/* one that comb both reads and hands out is an input */
		const box = "type Box<T> = { get: () => T; set: (value: T) => void }\n"
		expect(lint(`${box}export function on(box: Box<Partial<{ a: number }>>) { return box.get() }\n`)).toEqual([
			{ file: at, message: PARTIAL },
		])
		/* one another type parameter is bounded by is a caller's, and an alias naming itself adds no flow */
		expect(
			lint(
				"type G<T, U extends T = T> = { get: () => U }\nexport function make(): G<Partial<{ a: number }>> { return { get: () => ({}) } }\n",
			),
		).toEqual([{ file: at, message: PARTIAL }])
		expect(
			lint(
				"type L<T> = { next: L<T> | null; get: () => T }\nexport function make(): L<Partial<{ a: number }>> { return { next: null, get: () => ({}) } }\n",
			),
		).toEqual([])
		/* a parameter the alias never uses, and a type argument of a type src does not declare, flow as written */
		expect(
			lint(
				"type Tag<T> = { tag: string }\nexport function make(): Tag<Partial<{ a: number }>> { return { tag: '' } }\n",
			),
		).toEqual([])
		expect(lint("export function make(): Promise<Partial<{ a: number }>> { return Promise.resolve({}) }\n")).toEqual([])
	})
})

describe("comb/optional-undefined through heritage, mapped types and private fields", () => {
	it("rejects an optional mapped type that refuses undefined, and allows one that takes it or is required (L3)", () => {
		expect(lint("export function f(o: { [K in 'a' | 'b']?: string }) { return o }\n")).toEqual([
			{ file: at, message: MAPPED },
		])
		expect(lint("export type M = { readonly [K in 'a']+?: number }\n")).toEqual([{ file: at, message: MAPPED }])
		expect(
			lint(
				"export type M = { [K in 'a']?: string | undefined }\nexport type R = { [K in 'a']-?: string }\nexport type N = { [K in 'a']: string }\nexport type U = { [K in 'a']?: undefined }\n",
			),
		).toEqual([])
	})

	it("reads a private or #-named class field as comb's own state, and a protected one as a subclass's input (L4)", () => {
		expect(
			lint(
				"export class C { private seen: Partial<Record<string, number>> = {}; #own: Partial<{ a: number }> = {}; private log?: number; #at?: number }\n",
			),
		).toEqual([])
		expect(lint("export class C { protected seen: Partial<{ a: number }> = {}; protected log?: number }\n")).toEqual([
			{ file: at, message: PARTIAL },
			{ file: at, message: MESSAGE },
		])
	})

	it("follows an interface's extends and a class's implements as references (L5)", () => {
		expect(
			lint("type B = { a: number }\ninterface A extends Partial<B> {}\nexport function f(a: A) { return a }\n"),
		).toEqual([{ file: at, message: PARTIAL }])
		expect(
			lint("type B = { a: number }\ninterface A extends Partial<B> {}\nexport function f(): A { return {} }\n"),
		).toEqual([])
		/* an alias only an interface's extends names flows as that interface does */
		const extended = "type B = Partial<{ a: number }>\ninterface A extends B {}\n"
		expect(lint(`${extended}export function f(): A { return {} }\n`)).toEqual([])
		expect(lint(`${extended}export function f(a: A) { return a }\n`)).toEqual([{ file: at, message: PARTIAL }])
		expect(
			lint("type B = { a: number }\nexport class C implements Partial<B> {}\nexport function f(c: C) { return c }\n"),
		).toEqual([])
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

/* D3-3 of the area D round-three review: K1, K2, K3, K4 and K11 of its probe, each with its control */
const TUPLE =
	"an optional tuple element takes undefined, which comb reads as the element left out: declare it `[name?: T | undefined]`, an unnamed one `[(T | undefined)?]`"

describe("comb/optional-undefined across files, in tuples and on abstract members", () => {
	it("reads a generic alias another src file declares the way its parameter flows there (K1, K2)", () => {
		const fixture = {
			"packages/core/src/query/alias.ts": "export type Setter<T> = (value: T) => void\n",
			"packages/core/src/query/make.ts":
				"import type { Setter } from './alias.ts'\nexport function make(): Setter<Partial<{ a: number }>> { return (v) => void v.a }\n",
			"packages/core/src/query/on.ts":
				"import type { Setter } from './alias.ts'\nexport function on(listener: Setter<Partial<{ a: number }>>) { listener({}) }\n",
		}
		expect(oxlintReports("optional-undefined", fixture)).toEqual([
			{ file: "packages/core/src/query/make.ts", message: PARTIAL },
		])
		expect(reportsOnDisk(rule, fixture)).toEqual([{ file: "packages/core/src/query/make.ts", message: PARTIAL }])
	})

	it("rejects an optional tuple element whose type refuses undefined, named or not (K3, K4)", () => {
		expect(lint("export function f(args: [a: string, b?: number]) { return args }\n")).toEqual([
			{ file: at, message: TUPLE },
		])
		expect(lint("export function f(args: [string, number?]) { return args }\n")).toEqual([{ file: at, message: TUPLE }])
		expect(
			lint(
				"export type T = [a: string, b?: number | undefined]\nexport type U = [string, (number | undefined)?]\nexport type R = [a: string, b: number]\nexport type P = { a?: (number | undefined) }\n",
			),
		).toEqual([])
	})

	it("rejects an abstract optional member whose type refuses undefined, and reads an abstract field as an input (K11)", () => {
		expect(lint("export abstract class C { abstract log?: number; abstract flush?(): void }\n")).toEqual([
			{ file: at, message: MESSAGE },
			{ file: at, message: MESSAGE },
		])
		expect(lint("export abstract class C { abstract seen: Partial<{ a: number }> }\n")).toEqual([
			{ file: at, message: PARTIAL },
		])
		expect(lint("export abstract class C { abstract log?: number | undefined; abstract flush(): void }\n")).toEqual([])
	})
})
