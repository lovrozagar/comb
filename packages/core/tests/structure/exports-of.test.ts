/**
 * KT3 of r22b: the released-exports guard hashed each export's own declaration, so a change inside
 * an unexported type it names (`BaseConstraints` under `TextConstraints`) left its hash as it was,
 * and the newest Upgrading section's `Changed:` list missed a change consumers' compilers see.
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { apiOf, releasedApiOf } from "./support/exports-of.ts"

const made: string[] = []
afterEach(() => {
	for (const dir of made.splice(0)) rmSync(dir, { force: true, recursive: true })
})

const BASE = `/** what every text column takes */
export type Base = { autogenerate?: boolean; inner: Inner }
type Inner = { label: string }
`

/**
 * A package whose root exports `Text`, which names the unexported `Base`, and `UsesShared`, which names
 * the exported `Shared`, then `index`
 */
function fixture(
	base: string,
	{ index = "", inner = false, shared = "export type Shared = { s: string }\n" } = {},
): string {
	const root = mkdtempSync(join(tmpdir(), "comb-exports-of-"))
	made.push(root)
	mkdirSync(join(root, "src"))
	const compilerOptions = {
		allowImportingTsExtensions: true,
		declaration: true,
		module: "esnext",
		moduleResolution: "bundler",
		noEmit: true,
		skipLibCheck: true,
		strict: true,
		target: "es2023",
		types: [],
	}
	const files = {
		"package.json": JSON.stringify({
			exports: { ".": { default: "./src/index.ts", types: "./types/index.d.ts" }, "./package.json": "./package.json" },
		}),
		"src/base.ts": base,
		"src/index.ts": `import type { Base } from "./base.ts"
import type { Shared } from "./shared.ts"
export type { Shared } from "./shared.ts"
${inner ? 'export type { Inner } from "./base.ts"\n' : ""}export type Text = Base & { max: number }
export type UsesShared = { shared: Shared }
${index}`,
		"src/shared.ts": shared,
		"tsconfig.json": JSON.stringify({ compilerOptions, include: ["src"] }),
		"tsconfig.strict.json": JSON.stringify({ extends: "./tsconfig.json" }),
	}
	for (const [file, text] of Object.entries(files)) writeFileSync(join(root, file), text)
	return root
}

const hashes = (root: string) => apiOf(root).exports["."] as Record<string, string>

/** The hashes of a package that also exports `pick`, its one parameter written as `layout` */
const pick = (layout: string) =>
	hashes(fixture(BASE, { index: `export function pick(${layout}): boolean {\n\treturn folded\n}\n` }))

describe("an export's hash covers what a consumer's compiler reads for it (KT3; siblings: comments, exported types)", () => {
	it("changes when an unexported type it names changes, however deep", () => {
		const before = hashes(fixture(BASE))
		expect(Object.keys(before)).toEqual(["Shared", "Text", "UsesShared"])
		const dropped = hashes(fixture(BASE.replace("autogenerate?: boolean; ", "")))
		expect(dropped["Text"]).not.toBe(before["Text"])
		const deeper = hashes(fixture(BASE.replace("label: string", "label: number")))
		expect(deeper["Text"]).not.toBe(before["Text"])
	})

	it("keeps every hash when only a comment changes", () => {
		expect(hashes(fixture(BASE.replace("what every text column takes", "what a text column takes")))).toEqual(
			hashes(fixture(BASE)),
		)
	})

	/* the formatter splits a binding pattern whose type gains a member comment, with a trailing comma tsc's declarations keep (buildFtsMatch, 3.1) */
	it("keeps every hash when only layout changes, a trailing comma among it", () => {
		const oneLine = "{ folded = false }: { folded?: boolean } = {}"
		expect(pick("{\n\tfolded = false,\n}: {\n\t/** folded or not */\n\tfolded?: boolean\n} = {},\n")).toEqual(
			pick(oneLine),
		)
		expect(pick("{ folded = false, other = 1 }: { folded?: boolean; other?: number } = {}")["pick"]).not.toBe(
			pick(oneLine)["pick"],
		)
	})

	it("changes each export that names a changed exported type, and none when a type only becomes exported", () => {
		const before = hashes(fixture(BASE))
		const after = hashes(fixture(BASE, { shared: "export type Shared = { s: number }\n" }))
		expect({
			shared: after["Shared"] === before["Shared"],
			uses: after["UsesShared"] === before["UsesShared"],
		}).toEqual({
			shared: false,
			uses: false,
		})
		/* 0.21 exports types 0.20.1 kept internal (KT6): what a consumer reads for Text stays as it was */
		const published = hashes(fixture(BASE.replace("type Inner", "export type Inner"), { inner: true }))
		expect(published["Text"]).toBe(before["Text"])
	})
})

const MEMBERS = `type Hidden = { inner: string }
export class Kept extends Error {
	#secret = 1
	private quiet = 2
	static made = 3
	column?: string
	toJSON(): object { return {} }
}
export interface Wide extends Narrow { extra?: number }
interface Narrow { name: string }
export type Mixed = Narrow & Partial<{ later: number }> & { required: Hidden }
export type Either = { kind: "a"; a?: string; both: number } | { kind: "b"; both?: number }
export type Mapped = { [K in "x"]: string }
const KEY = "x-key"
export type Keyed = { [KEY]: number; plain?: string }
`

describe("the members of each type an export reaches, as a consumer's compiler reads them", () => {
	it("lists each public member optional or required, through bases, intersections, unions, mapped types and computed keys", () => {
		const root = fixture(BASE)
		writeFileSync(join(root, "src/index.ts"), MEMBERS)
		const { members } = apiOf(root)
		expect(members).toEqual({
			Either: { both: "optional", kind: "required" },
			Hidden: { inner: "required" },
			/* a dependency's base adds none: Error's members are its own to change, and its release notes' to name */
			Kept: { column: "optional", toJSON: "required" },
			Keyed: { plain: "optional", "x-key": "required" },
			Mapped: { x: "required" },
			Mixed: { later: "optional", name: "required", required: "required" },
			Narrow: { name: "required" },
			Wide: { extra: "optional", name: "required" },
		})
	})
})

describe("two types an export reaches under one name, with different members", () => {
	it("throw for a tree, whose newer one is renamed in src", () => {
		const root = fixture(BASE)
		writeFileSync(join(root, "src/a.ts"), "export type Shared = { a: string }\n")
		writeFileSync(join(root, "src/b.ts"), "type Shared = { b?: number }\nexport type UsesB = { shared: Shared }\n")
		writeFileSync(
			join(root, "src/index.ts"),
			'export type { Shared } from "./a.ts"\nexport type { UsesB } from "./b.ts"\n',
		)
		expect(() => apiOf(root)).toThrow("two types an export reaches are named Shared, with different members")
	})

	/* 0.20.1 reached the exported ListQueryInput of query/types.ts and a z.ZodObject list-schema.ts called by that name */
	it("are the exported one in a release, which is past renaming", () => {
		const dir = mkdtempSync(join(tmpdir(), "comb-exports-of-released-"))
		made.push(dir)
		mkdirSync(join(dir, "types"))
		const files = {
			"package.json": JSON.stringify({ exports: { ".": { default: "./src/index.ts", types: "./types/index.d.ts" } } }),
			"types/a.d.ts": "export type Shared = { a: string }\n",
			"types/b.d.ts": "type Shared = { b?: number }\nexport type UsesB = { shared: Shared }\nexport {}\n",
			"types/index.d.ts": 'export type { Shared } from "./a.js"\nexport type { UsesB } from "./b.js"\n',
		}
		for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text)
		expect(releasedApiOf(dir).members).toEqual({ Shared: { a: "required" }, UsesB: { shared: "required" } })
	})
})

const TAKES = `type Inner = { label: string }
export type Config = { inner: Inner; name?: string }
type Seed = { seed: number }
type Arg = { arg: string }
type Made = { made: boolean }
type Res = { x: number }
export type Out = { result: Res }
type Ctx = { ctx: string }
export type Callback = (ctx: Ctx) => void
export function define(config: Config): Config {
	return config
}
export function run(): Out {
	return { result: { x: 1 } }
}
export class Box {
	constructor(seed: Seed) {
		void seed
	}
	put(arg: Arg): void {
		void arg
	}
}
export const make = (made: Made): number => (made.made ? 1 : 0)
`

/* AD7-3 of the area D round-seven review: a member added as required to a type a consumer passes is a break no hash names */
describe("the types a callable export takes, which a consumer writes", () => {
	it("are each local type a function, class or const of function type takes, and each type those name", () => {
		const root = fixture(BASE)
		writeFileSync(join(root, "src/index.ts"), TAKES)
		expect(apiOf(root).inputs).toEqual(["Arg", "Config", "Inner", "Made", "Seed"])
	})
})
