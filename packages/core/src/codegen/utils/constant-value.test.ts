/**
 * Constraint constants read from source, never run: a module with side effects, or one that throws,
 * still gives up its literals, and a value only running could produce fails codegen where it stands.
 */
import fs from "node:fs"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { SyntaxKind } from "ts-morph"
import { analyze } from "../analyzer.ts"
import { constraintsAt } from "./constraint-reader.ts"
import { createProjectFromTablesDir } from "./ts-morph.ts"

const CORE = path.join(import.meta.dirname, "../../..")

const made: string[] = []
afterEach(() => {
	for (const dir of made.splice(0)) fs.rmSync(dir, { force: true, recursive: true })
})

/** A directory inside the package (so `@lovrozagar/comb/*` resolves as a consumer's would) holding `files` */
function dirWith(files: Record<string, string>): string {
	const dir = fs.mkdtempSync(path.join(CORE, ".tmp-constants-"))
	made.push(dir)
	for (const [name, text] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
		fs.writeFileSync(path.join(dir, name), text)
	}
	return dir
}

const HEAD = `import { sqliteTable } from "drizzle-orm/sqlite-core"
import { c } from "@lovrozagar/comb/sqlite/columns"
`

/** Each column's constraints in a tables file of `columns` (after HEAD and `imports`), read as analyze reads them */
function constants(files: Record<string, string>, imports: string, columns: string) {
	const dir = dirWith({
		...files,
		"db.x.tables.ts": `${HEAD}${imports}\nexport const t = sqliteTable("t", { id: c.id("t"), ${columns} })\n`,
	})
	const tables = path.join(dir, "db.x.tables.ts")
	const project = createProjectFromTablesDir(tables)
	const call = project.getSourceFileOrThrow(tables).getVariableDeclarationOrThrow("t").getInitializerOrThrow()
	const object = call.asKindOrThrow(SyntaxKind.CallExpression).getArguments()[1]
	const read = (object?.asKindOrThrow(SyntaxKind.ObjectLiteralExpression).getProperties() ?? []).map((property) => {
		const assigned = property.asKindOrThrow(SyntaxKind.PropertyAssignment)
		return [assigned.getName(), constraintsAt(project, assigned.getInitializerOrThrow())] as const
	})
	return Object.fromEntries(read.filter(([, record]) => Object.keys(record).length > 0))
}

describe("constraint constants, read statically", () => {
	it("reads a literal from a module whose top level throws and imports comb, and never runs it", () => {
		const marker = path.join(CORE, `.tmp-constants-ran-${process.pid}`)
		made.push(marker)
		const values = constants(
			{
				"limits.ts": `import { CombError } from "@lovrozagar/comb"
import { appendFileSync } from "node:fs"
appendFileSync(${JSON.stringify(marker)}, "ran")
export const LIMITS = { NAME: 80, ENABLED: true } as const
throw new CombError({ errorKey: "x", status: "bad_request" })
`,
			},
			'import { LIMITS } from "./limits.ts"',
			'name: c.text("name", { max: LIMITS.NAME, trim: LIMITS.ENABLED })',
		)
		expect(values).toEqual({ name: { max: 80, trim: true } })
		expect(fs.existsSync(marker)).toBe(false)
	})

	it("reads comb's own pattern constant through its package export", () => {
		const values = constants(
			{},
			'import { patterns } from "@lovrozagar/comb/sqlite/patterns"',
			'phone: c.text("phone", { pattern: patterns.E164_PHONE })',
		)
		expect(values).toEqual({ phone: { pattern: "/^\\+[1-9]\\d{7,14}$/" } })
	})

	it("follows a re-export chain, an alias, `export *`, `as const`, `satisfies` and a const referencing a const", () => {
		const values = constants(
			{
				"base.ts": 'export const SLUG = "^[a-z-]+$"\nexport const MAX = 40 satisfies number\n',
				"index.ts": 'export * from "./other.ts"\nexport { RULES as R } from "./rules.ts"\n',
				"other.ts": "export const NOTHING = 1\n",
				"rules.ts":
					'import { SLUG, MAX } from "./base.ts"\nconst LOCAL = { SLUG, LONG: MAX } as const\nexport const RULES = LOCAL\n',
			},
			'import { R } from "./index.ts"',
			'slug: c.text("slug", { pattern: R.SLUG, max: R.LONG })',
		)
		expect(values).toEqual({ slug: { max: 40, pattern: "^[a-z-]+$" } })
	})

	it("reads a regex literal, new RegExp with literal arguments, a negative number and a bare const", () => {
		const values = constants(
			{},
			'const CODE = /^[A-Z]{3}$/i\nconst PATH = new RegExp("^a/b$", "u")\nconst LOW = -5\nconst OFF = false',
			'code: c.text("code", { pattern: CODE }), path: c.text("path", { pattern: PATH }), n: c.integer("n", { min: LOW }), t: c.text("tt", { trim: OFF })',
		)
		expect(values).toEqual({
			code: { pattern: "/^[A-Z]{3}$/i" },
			n: { min: -5 },
			path: { pattern: "/^a\\/b$/u" },
			t: { trim: false },
		})
	})
})

describe("constraint constants that only running could produce", () => {
	it.each([
		{
			constraint: "max: MAX",
			imports: "const MAX = Math.max(1, 2)",
			name: "a computed initializer",
			why: /Math\.max\(1, 2\) is computed/,
		},
		{ constraint: "max: MAX", imports: "let MAX = 3", name: "a let", why: /MAX is not a const/ },
		{
			constraint: "max: MAX",
			imports: "const MAX: number = undefined!",
			name: "a const with nothing it can read",
			why: /undefined is not a const/,
		},
		{
			constraint: "max: RULES.MAX",
			imports: "const RULES = makeRules()",
			name: "a property of a call",
			why: /makeRules\(\) is not an object literal/,
		},
		{
			constraint: "max: RULES.MAX",
			imports: "const RULES = { MIN: 1 }",
			name: "a missing property",
			why: /has no plain property MAX/,
		},
		{
			constraint: "max: NOWHERE",
			imports: "",
			name: "a name bound nowhere",
			why: /NOWHERE is not a const of its file or an import of one/,
		},
		{
			constraint: "max: R.MAX",
			imports: 'import { R } from "./missing.ts"',
			name: "a module that does not resolve",
			why: /"\.\/missing\.ts" does not resolve/,
		},
	])("fails codegen on $name, naming the file, the line and the expression", ({ constraint, imports, why }) => {
		const dir = dirWith({
			"db.x.tables.ts": `${HEAD}${imports}\nexport const t = sqliteTable("t", {\n\tid: c.id("t"),\n\tn: c.integer("n", { ${constraint} }),\n})\n`,
		})
		expect(() => analyze(path.join(dir, "db.x.tables.ts"))).toThrow(/db\.x\.tables\.ts:\d+: comb cannot read /)
		expect(() => analyze(path.join(dir, "db.x.tables.ts"))).toThrow(why)
	})
})

describe("constraint constants across exports, and RegExp and declarations it cannot read", () => {
	it("reads a same-file aliased export, skips an export that misses before a `export *` that holds the name, and reads each use at its own node", () => {
		const values = constants(
			{
				"index.ts":
					'export { OTHER } from "./other.ts"\nexport * from "./rules.ts"\nconst LOCAL = { MAX: 9 } as const\nexport { LOCAL as L }\n',
				"other.ts": "export const OTHER = 1\n",
				"rules.ts": "export const RULES = { MIN: 2 } as const\n",
			},
			'import { L, RULES } from "./index.ts"',
			'a: c.integer("a", { max: L.MAX, min: RULES.MIN }), b: c.integer("b", { max: L.MAX })',
		)
		expect(values).toEqual({ a: { max: 9, min: 2 }, b: { max: 9 } })
	})

	it.each([
		{
			declaration: "const CODE = new RegExp()",
			name: "new RegExp without arguments",
			why: /new RegExp\(\) is computed/,
		},
		{ declaration: 'const CODE = new RegExp("a", FLAGS)', name: "new RegExp with computed flags", why: /is computed/ },
		{
			declaration: "declare const CODE: string",
			name: "a const without an initializer",
			why: /CODE has no initializer/,
		},
		{
			declaration: 'import { CODE } from "./barrel.ts"',
			name: "an `export *` of a module that does not resolve",
			why: /"\.\/missing\.ts" does not resolve/,
		},
	])("fails codegen on $name", ({ declaration, why }) => {
		const dir = dirWith({
			"barrel.ts": 'export * from "./inner.ts"\n',
			/* an `export *` target that itself names a module that does not resolve: the failure is kept, not read as a miss */
			"inner.ts": 'export * from "./missing.ts"\n',
			"db.x.tables.ts": `${HEAD}${declaration}\nexport const t = sqliteTable("t", { id: c.id("t"), code: c.text("code", { pattern: CODE }) })\n`,
		})
		expect(() => analyze(path.join(dir, "db.x.tables.ts"))).toThrow(why)
	})

	it("fails on a module that ships only declarations, and on a reference cycle", () => {
		const declared = dirWith({
			"db.x.tables.ts": `${HEAD}import { R } from "./types.ts"\nexport const t = sqliteTable("t", { id: c.id("t"), n: c.integer("n", { max: R.MAX }) })\n`,
			"types.d.ts": "export declare const R: { MAX: number }\n",
		})
		expect(() => analyze(path.join(declared, "db.x.tables.ts"))).toThrow(/ships only declarations/)
		const cycle = dirWith({
			"db.x.tables.ts": `${HEAD}const A = B\nconst B = A\nexport const t = sqliteTable("t", { id: c.id("t"), n: c.integer("n", { max: A }) })\n`,
		})
		expect(() => analyze(path.join(cycle, "db.x.tables.ts"))).toThrow(/more than 8 references/)
	})
})

describe("one constant name in two table files (F1)", () => {
	it("reads each file's own NAME_MAX, not the first file's for both", () => {
		const dir = dirWith({
			"alpha.ts": `${HEAD}const NAME_MAX = 10\nexport const alpha = sqliteTable("alpha", { id: c.id("a"), name: c.text("name", { max: NAME_MAX }) })\n`,
			"beta.ts": `${HEAD}const NAME_MAX = 200\nexport const beta = sqliteTable("beta", { id: c.id("b"), name: c.text("name", { max: NAME_MAX }) })\n`,
			"db.x.tables.ts": 'export * from "./alpha.ts"\nexport * from "./beta.ts"\n',
		})
		const { tables } = analyze(path.join(dir, "db.x.tables.ts"))
		const maxOf = (name: string) =>
			tables.find((table) => table.varName === name)?.fields.find((f) => f.name === "name")?.constraints.max
		expect([maxOf("alpha"), maxOf("beta")]).toEqual([10, 200])
	})
})

describe("a pattern comb cannot emit, through analyze (F5, F6)", () => {
	it.each([
		['pattern: "^[a-z]+$"', /is not a regex/],
		["pattern: /^[a-z]+$/i", /takes the flag i/],
	])("fails codegen on %s at the field's place", (constraint, why) => {
		const dir = dirWith({
			"db.x.tables.ts": `${HEAD}export const t = sqliteTable("t", { id: c.id("t"), name: c.text("name", { ${constraint} }) })\n`,
		})
		expect(() => analyze(path.join(dir, "db.x.tables.ts"))).toThrow(/db\.x\.tables\.ts:\d+: name: pattern /)
		expect(() => analyze(path.join(dir, "db.x.tables.ts"))).toThrow(why)
	})
})

describe("constants reached the other ways TypeScript allows (F22)", () => {
	it("reads through a tsconfig paths alias", () => {
		const values = constants(
			{
				"lib/limits.ts": "export const LIMITS = { NAME: 80 } as const\n",
				"tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@lib/*": ["lib/*"] } } }),
			},
			'import { LIMITS } from "@lib/limits"',
			'name: c.text("name", { max: LIMITS.NAME })',
		)
		expect(values).toEqual({ name: { max: 80 } })
	})

	it("reads through a namespace import, a default import and an `export * as` re-export", () => {
		const values = constants(
			{
				"barrel.ts": 'export * as L from "./limits.ts"\n',
				"defaults.ts": "export default { MIN: 2 } as const\n",
				"limits.ts": "export const MAX = 9\n",
			},
			'import * as LIM from "./limits.ts"\nimport D from "./defaults.ts"\nimport { L } from "./barrel.ts"',
			'a: c.text("a", { max: LIM.MAX }), b: c.text("b", { min: D.MIN }), d: c.text("d", { max: L.MAX })',
		)
		expect(values).toEqual({ a: { max: 9 }, b: { min: 2 }, d: { max: 9 } })
	})

	it("reads a default export written as `export { X as default }`", () => {
		const values = constants(
			{ "defaults.ts": "const X = { MIN: 3 } as const\nexport { X as default }\n" },
			'import D from "./defaults.ts"',
			'b: c.text("b", { min: D.MIN })',
		)
		expect(values).toEqual({ b: { min: 3 } })
	})

	it("fails on a namespace import used as a value, naming it", () => {
		expect(() =>
			constants(
				{ "limits.ts": "export const MAX = 9\n" },
				'import * as LIM from "./limits.ts"',
				'a: c.text("a", { max: LIM })',
			),
		).toThrow(/LIM is a module, not a value: name one of its exports/)
	})

	it("still fails on a namespace member the module does not export", () => {
		expect(() =>
			constants(
				{ "limits.ts": "export const MAX = 9\n" },
				'import * as LIM from "./limits.ts"',
				'a: c.text("a", { max: LIM.NOPE })',
			),
		).toThrow(/limits\.ts exports no NOPE/)
	})
})
