/**
 * comb/public-jsdoc: every declaration a package's `exports` reach, and every member a consumer can see on it, carries
 * written JSDoc. In process over a package written to disk, because the rule reads the rest of the package from there,
 * and once through the real oxlint binary.
 */
import { describe, expect, it } from "vitest"
import { rule } from "./public-jsdoc.js"
import { type Fixture, oxlintReports, reportsOnDisk } from "./rule-harness.ts"

const MANIFEST = JSON.stringify({
	exports: { ".": { "types@>=5.7": "./types/index.d.ts", default: "./src/index.ts" } },
})

const missing = (name: string, entry = ".") =>
	`\`${name}\` is public through "${entry}" and has no JSDoc: add a /** */ block that says what a caller needs and the type does not`
const empty = (name: string) =>
	`\`${name}\` is public through "." and its JSDoc is empty: say what a caller needs and the type does not`
const restates = (name: string) =>
	`\`${name}\` is public through "." and its JSDoc only restates the name: say what a caller needs and the type does not`
const internal = (name: string) =>
	`\`${name}\` is public through "." and its JSDoc cites an internal reference, which ships to consumers: say it in their terms`
const sameLine = (name: string) =>
	`\`${name}\` is public through "." and its JSDoc shares a line with the code before it, so editors do not show it: put it on its own line`
const inferred = (name: string) =>
	`\`${name}\` is public through "." and its type is inferred, so its shape goes unchecked: write the type out`

const reports = (fixture: Fixture) => reportsOnDisk(rule, fixture)

function messages(code: string, extra: Record<string, string> = {}): string[] {
	return reports({ "package.json": MANIFEST, "src/index.ts": code, ...extra }).map((report) => report.message)
}

describe("comb/public-jsdoc: through oxlint", () => {
	it("reports an undocumented export function through the comb plugin", () => {
		const fixture = { "package.json": MANIFEST, "src/index.ts": "export function f(): void {}\n" }
		expect(oxlintReports("public-jsdoc", fixture)).toEqual([{ file: "src/index.ts", message: missing("f") }])
	})
})

describe("comb/public-jsdoc: what needs a doc", () => {
	it.each([
		["a function", "export function f(): void {}\n", ["f"]],
		["a class", "export class C {}\n", ["C"]],
		["an interface", "export interface I {}\n", ["I"]],
		["a type alias", "export type T = string\n", ["T"]],
		["a constant", "export const c = 1\n", ["c"]],
		["an enum and its member", "export enum E { A }\n", ["E", "E.A"]],
		["a default export", "export default function d(): void {}\n", ["d"]],
		["an anonymous default export", "export default function (): void {}\n", ["default"]],
		[
			"each overload",
			"export function f(a: string): void\nexport function f(a: number): void\nexport function f(a: unknown): void {}\n",
			["f", "f"],
		],
		["a type member", "/** The shape. */\nexport type T = { a: string }\n", ["T.a"]],
		["a nested member", "/** The shape. */\nexport type T = {\n/** The inner. */\na: { b: string } }\n", ["T.b"]],
		[
			"a union and intersection member",
			"/** The shape. */\nexport type T = { a: string } & ({ b: string } | { c: string })\n",
			["T.a", "T.b", "T.c"],
		],
		["an interface method", "/** The shape. */\nexport interface I { m(): void }\n", ["I.m"]],
		["a call signature", "/** The shape. */\nexport interface I { (a: string): void }\n", ["I.(call)"]],
		["a construct signature", "/** The shape. */\nexport interface I { new (a: string): I }\n", ["I.(new)"]],
		["an index signature", "/** The shape. */\nexport interface I { [key: string]: unknown }\n", ["I.(index)"]],
		["a class index signature", "/** The class. */\nexport class C { [key: string]: unknown }\n", ["C.(index)"]],
		["a member of a parameter's literal", "/** Runs. */\nexport function f(o: { a: string }): void {}\n", ["f.a"]],
		["a class method", "/** The class. */\nexport class C { m(): void {} }\n", ["C.m"]],
		["a class constructor", "/** The class. */\nexport class C { constructor(a: string) {} }\n", ["C.constructor"]],
		["a class property", "/** The class. */\nexport class C { p: string = '' }\n", ["C.p"]],
		["a class accessor", "/** The class. */\nexport class C { get g(): string { return '' } }\n", ["C.g"]],
		["a static method", "/** The class. */\nexport class C { static m(): void {} }\n", ["C.m"]],
		["a string-keyed member", '/** The shape. */\nexport type T = { "a-b": string }\n', ["T.a-b"]],
		[
			"an instance method beside a static overload of its name",
			"/** The class. */\nexport class C {\n/** By name. */\nstatic m(a: string): void\n/** By id. */\nstatic m(a: number): void\nstatic m(a: unknown): void {}\nm(): void {} }\n",
			["C.m"],
		],
		[
			"a parameter property",
			"/** The class. */\nexport class C {\n/** Makes it. */\nconstructor(readonly p: string) {} }\n",
			["C.p"],
		],
		[
			"a class method overload",
			"/** The class. */\nexport class C { m(a: string): void\nm(a: number): void\nm(a: unknown): void {} }\n",
			["C.m", "C.m"],
		],
		[
			"a well-known symbol key",
			"/** The class. */\nexport class C { [Symbol.iterator](): Iterator<string> { return [].values() } }\n",
			["C.Symbol.iterator"],
		],
		["a computed key it cannot name", '/** The shape. */\nexport type T = { ["a" + "b"]: string }\n', ["T.(computed)"]],
	])("requires it on %s", (_, code, names) => {
		expect(messages(code)).toEqual(names.map((name) => missing(name)))
	})
})

describe("comb/public-jsdoc: where a report lands", () => {
	it("finds a re-exported declaration and an unexported reachable type where they are defined", () => {
		const fixture = {
			"package.json": MANIFEST,
			"src/index.ts": 'export { connect as open } from "./connect.ts"\n',
			"src/connect.ts": "type Options = { url: string }\nexport function connect(options: Options): void {}\n",
		}
		expect(reports(fixture)).toEqual([
			{ file: "src/connect.ts", message: missing("Options") },
			{ file: "src/connect.ts", message: missing("Options.url") },
			{ file: "src/connect.ts", message: missing("connect") },
		])
	})

	it("names the entry that reaches a declaration first", () => {
		const manifest = JSON.stringify({
			exports: { ".": { default: "./src/index.ts" }, "./cli": { default: "./src/cli.ts" } },
		})
		const fixture = { "package.json": manifest, "src/index.ts": "export {}\n", "src/cli.ts": "export const run = 1\n" }
		expect(reports(fixture)).toEqual([{ file: "src/cli.ts", message: missing("run", "./cli") }])
	})
})

describe("comb/public-jsdoc: what passes", () => {
	it.each([
		["a documented function", "/** Runs it. */\nexport function f(): void {}\n"],
		["a documented constant", "/** How many fit. */\nexport const c = 1\n"],
		["a doc above a line comment", "/** Runs it. */\n// oxlint-disable-next-line\nexport function f(): void {}\n"],
		[
			"overloads, implementation bare",
			"/** By name. */\nexport function f(a: string): void\n/** By id. */\nexport function f(a: number): void\nexport function f(a: unknown): void {}\n",
		],
		[
			"a class overload implementation",
			"/** The class. */\nexport class C {\n/** By name. */\nm(a: string): void\n/** By id. */\nm(a: number): void\nm(a: unknown): void {} }\n",
		],
		[
			"a setter beside its documented getter",
			"/** The class. */\nexport class C {\n/** The size. */\nget g(): string { return '' }\nset g(v: string) {} }\n",
		],
		[
			"private, protected and # members",
			"/** The class. */\nexport class C { private a = new Set(); protected b(): void {} #c = 1; #d(): void {} }\n",
		],
		[
			"a private parameter property",
			"/** The class. */\nexport class C {\n/** Makes it. */\nconstructor(private p: string) {} }\n",
		],
		[
			"a plain identifier computed key",
			"const SELF = Symbol()\n/** The class. */\nexport class C { [SELF]: string = '' }\n",
		],
		[
			"a plain identifier computed key on a type",
			"const SELF = Symbol()\n/** The shape. */\nexport type T = { [SELF]: string }\n",
		],
		[
			"a static block's own locals",
			'/** The class. */\nexport class C { static { const o: { a: string } = { a: "" }; void o } }\n',
		],
		["a conditional's extends pattern", "/** Picks. */\nexport type P<T> = T extends { a: infer U } ? U : never\n"],
		["a method's parameter default", "/** The class. */\nexport class C {\n/** Runs. */\nm(a = { b: 1 }): void {} }\n"],
		[
			"a function's body",
			"/** Runs. */\nexport function f(): void { type T = { a: string }; const x: T = { a: '' }; void x }\n",
		],
		["an export no entry reaches", 'export { a } from "./a.ts"\n'],
		["a namespace merged into nothing public", "namespace N { export const a = 1 }\nexport {}\n"],
	])("accepts %s", (_, code) => {
		const a = "/** The first letter. */\nexport const a = 1\nexport const unreached = 2\n"
		expect(messages(code, { "src/a.ts": a })).toEqual([])
	})
})

describe("comb/public-jsdoc: what it stays out of", () => {
	it.each([
		["a plain string export", '{"exports":{".":"./src/index.ts"}}'],
		["a default outside ./src/", '{"exports":{".":{"default":"./dist/index.js"}}}'],
	])("stays out of a package with %s", (_, manifest) => {
		expect(reports({ "package.json": manifest, "src/index.ts": "export const a = 1\n" })).toEqual([])
	})

	it("stays out of a file no entry reaches", () => {
		const fixture = { "package.json": MANIFEST, "src/index.ts": "export {}\n", "src/other.ts": "export const a = 1\n" }
		expect(reports(fixture)).toEqual([])
	})
})

describe("comb/public-jsdoc: docs that say nothing", () => {
	it("rejects an empty doc", () => {
		expect(messages("/** */\nexport const size = 1\n")).toEqual([empty("size")])
	})

	it("rejects a doc with tags and no text", () => {
		expect(messages("/** @deprecated */\nexport const size = 1\n")).toEqual([empty("size")])
	})

	it("rejects a plain block comment", () => {
		expect(messages("/* The most that fits. */\nexport const size = 1\n")).toEqual([missing("size")])
	})

	it.each([
		["the name", "/** maxAge */\nexport const maxAge = 1\n", "maxAge"],
		["the name's words", "/** The max age. */\nexport const maxAge = 1\n", "maxAge"],
		["the name and stopwords", "/** This is the value of the max age option. */\nexport const maxAge = 1\n", "maxAge"],
		["a member's name", "/** The shape. */\nexport type T = {\n/** Origin. */\norigin: string }\n", "T.origin"],
		["nothing but punctuation", "/** ... */\nexport const maxAge = 1\n", "maxAge"],
	])("rejects a doc that restates %s", (_, code, name) => {
		expect(messages(code)).toEqual([restates(name)])
	})

	it("rejects a doc on the line of the code before it, which TypeScript does not attach", () => {
		const code =
			"/** The shape. */\nexport type T = { /** The first field. */ a: string; /** The second field. */ b: string }\n"
		expect(messages(code)).toEqual([sameLine("T.a"), sameLine("T.b")])
	})

	it("accepts a doc on the line of a parameter property, which TypeScript does attach", () => {
		const code =
			"/** The class. */\nexport class C {\n/** Makes it. */\nconstructor(/** The port it binds. */ readonly p: string) {} }\n"
		expect(messages(code)).toEqual([])
	})

	it("accepts a doc that adds a word to the name", () => {
		expect(messages("/** The max age, in seconds. */\nexport const maxAge = 1\n")).toEqual([])
	})
})

describe("comb/public-jsdoc: internal references", () => {
	it.each([
		["a review round", "/** The size, fixed in r22. */\nexport const size = 1\n"],
		["a lettered review round", "/** The size r22b settled. */\nexport const size = 1\n"],
		["a later review round", "/** The size, per r30. */\nexport const size = 1\n"],
		["a three-digit review round", "/** The size, per r104. */\nexport const size = 1\n"],
		["a milestone", "/** The size M75 set. */\nexport const size = 1\n"],
		["a plan", "/** The size plan 21 chose. */\nexport const size = 1\n"],
		["a capitalized plan", "/** Plan 21: the size. */\nexport const size = 1\n"],
		["a finding id", "/** The size PA1 asked for. */\nexport const size = 1\n"],
		["a two-digit finding id", "/** The size, per AD14. */\nexport const size = 1\n"],
		["a lettered finding id", "/** The size, per PA3n. */\nexport const size = 1\n"],
		["a step id", "/** The size, per B2-3. */\nexport const size = 1\n"],
		["a one-letter finding id", "/** Load it in `cwd` (F58). */\nexport const size = 1\n"],
		["a one-letter, one-digit finding id", "/** The size C7 published. */\nexport const size = 1\n"],
		["a lettered one-letter finding id", "/** The size, per S1n. */\nexport const size = 1\n"],
		["a one-digit milestone", "/** The size M5 set. */\nexport const size = 1\n"],
		["a three-digit milestone", "/** The size M123 set. */\nexport const size = 1\n"],
		["an id beside a look-alike", "/** The size D1 keeps (K7). */\nexport const size = 1\n"],
		["a tag's text", "/** The most that fits.\n * @see QL5\n */\nexport const size = 1\n"],
	])("rejects %s", (_, code) => {
		expect(messages(code)).toEqual([internal("size")])
	})

	it.each([
		["a Postgres version", "/** The size PG17 keeps. */\nexport const size = 1\n"],
		["a one-digit round", "/** The size of r2, the second register. */\nexport const size = 1\n"],
		["Cloudflare D1", "/** The size a D1 database keeps. */\nexport const size = 1\n"],
		["a plan with no number", "/** The size the plan allows. */\nexport const size = 1\n"],
		["RE2", "/** The pattern, as RE2 reads it. */\nexport const size = 1\n"],
		["an SQLSTATE", "/** The size past which Postgres raises XX000. */\nexport const size = 1\n"],
		["a language target", "/** The size ES2022 allows. */\nexport const size = 1\n"],
		["a hash name", "/** The size of a HS256 key. */\nexport const size = 1\n"],
	])("accepts %s", (_, code) => {
		expect(messages(code)).toEqual([])
	})
})

describe("comb/public-jsdoc: inferred shapes", () => {
	it.each([
		["a function's return", "/** Runs. */\nexport function f() { return { a: 1 } }\n", "f"],
		[
			"a constant from a call",
			"/** The table. */\nexport const c = make()\nfunction make(): number { return 1 }\n",
			"c",
		],
		["a constant from an object", "/** The table. */\nexport const c = { a: 1 }\n", "c"],
		["a constant with no value", "/** The table. */\nexport let c\n", "c"],
		["a constant from a template", "/** The name. */\nexport const c = `a${1}`\n", "c"],
		["a method's return", "/** The class. */\nexport class C {\n/** Runs. */\nm() { return 1 } }\n", "C.m"],
		["a getter's return", "/** The class. */\nexport class C {\n/** Runs. */\nget g() { return 1 } }\n", "C.g"],
		[
			"a class property from a call",
			"/** The class. */\nexport class C {\n/** The seen keys. */\nreadonly p = new Set<string>() }\n",
			"C.p",
		],
		["an arrow's return", "/** Runs. */\nexport const f = (a: string) => a\n", "f"],
	])("rejects %s", (_, code, name) => {
		expect(messages(code)).toEqual([inferred(name)])
	})

	it.each([
		["a string literal", '/** The name. */\nexport const c = "a"\n'],
		["a plain template", "/** The name. */\nexport const c = `a`\n"],
		["a negative number", "/** The floor. */\nexport const c = -1\n"],
		["a boolean", "/** The switch. */\nexport const c = true\n"],
		["arithmetic on numbers", "/** The ceiling. */\nexport const c = (128 * 1024) * 1024\n"],
		["as const", '/** The list. */\nexport const c = ["a", "b"] as const\n'],
		["as const with satisfies", '/** The list. */\nexport const c = ["a"] as const satisfies readonly string[]\n'],
		["an annotation", "/** The list. */\nexport const c: string[] = []\n"],
		["an explicit cast", "/** The list. */\nexport const c = [] as string[]\n"],
		["a typed arrow", "/** Runs. */\nexport const f = (a: string): string => a\n"],
		[
			"a constructor and a setter",
			"/** The class. */\nexport class C {\n/** Makes it. */\nconstructor() {}\n/** Sets it. */\nset s(v: string) {} }\n",
		],
		["a class literal", "/** The class. */\nexport class C {\n/** The size. */\nreadonly p = 1 }\n"],
	])("accepts %s", (_, code) => {
		expect(messages(code)).toEqual([])
	})
})

describe("comb/public-jsdoc: failing closed", () => {
	it("reports a form the surface cannot follow, on the file that has it", () => {
		const fixture = { "package.json": MANIFEST, "src/index.ts": "export namespace N { export const a = 1 }\n" }
		expect(reports(fixture)).toEqual([
			{
				file: "src/index.ts",
				message:
					"comb/public-jsdoc cannot follow TSModuleDeclaration here, so what it exposes goes unchecked: write it as a plain export",
			},
		])
	})

	const destructured = "/** The pair. */\nexport const [lo, hi]: number[] = [1, 2]\n"
	const merged =
		"/** Makes a box. */\nexport function Box(): void {}\nexport namespace Box {\n\texport const c = 1\n}\n"
	const namespace = "/** Helpers. */\nexport namespace Ns {\n\texport const extra = 3\n}\n"
	const unexportedMerge =
		"/** Makes a box. */\nfunction Box(): void {}\nnamespace Box {\n\texport const c = 1\n}\nexport { Box }\n"
	const star = 'export * from "./m.ts"\n'
	it.each([
		[
			"a destructured export behind export *",
			{ "src/index.ts": star, "src/m.ts": destructured },
			{ file: "src/m.ts", form: "ArrayPattern" },
		],
		[
			"a namespace behind export *",
			{ "src/index.ts": star, "src/m.ts": namespace },
			{ file: "src/m.ts", form: "TSModuleDeclaration" },
		],
		[
			"a merged namespace behind export *",
			{ "src/index.ts": star, "src/m.ts": merged },
			{ file: "src/m.ts", form: "TSModuleDeclaration" },
		],
		[
			"a merged namespace behind a named re-export",
			{ "src/index.ts": 'export { Box } from "./m.ts"\n', "src/m.ts": merged },
			{ file: "src/m.ts", form: "TSModuleDeclaration" },
		],
		[
			"a merged namespace left unexported",
			{ "src/index.ts": unexportedMerge },
			{ file: "src/index.ts", form: "TSModuleDeclaration" },
		],
		[
			"a namespace two stars down",
			{ "src/a.ts": star, "src/index.ts": 'export * from "./a.ts"\n', "src/m.ts": namespace },
			{ file: "src/m.ts", form: "TSModuleDeclaration" },
		],
		[
			"a star two stars down that names no file",
			{ "src/a.ts": star, "src/index.ts": 'export * from "./a.ts"\n' },
			{ file: "src/a.ts", form: "./m.ts" },
		],
	])("reports %s, once, on the file that has it", (_, files, { file, form }) => {
		const message = `comb/public-jsdoc cannot follow ${form} here, so what it exposes goes unchecked: write it as a plain export`
		expect(reports({ "package.json": MANIFEST, ...files })).toEqual([{ file, message }])
	})
})
