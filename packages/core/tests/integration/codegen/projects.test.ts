/**
 * `comb codegen` over whole projects, the layouts of the 0.7.0 review (fresh/codegen/proj and
 * proj2): two databases in one folder, two databases sharing one output and one package.json, and
 * a database named apart from its tables file. Each database gets only its own tables and its own
 * package exports, and every generated import resolves under tsc.
 */
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { runCli } from "../../../src/cli/index.ts"

const CORE = path.join(import.meta.dirname, "../../..")

const made: string[] = []
afterEach(() => {
	for (const dir of made.splice(0)) fs.rmSync(dir, { force: true, recursive: true })
})

/** A project inside the package, so its imports of comb and drizzle resolve as an installed app's would */
function project(files: Record<string, string>): string {
	const dir = fs.mkdtempSync(path.join(CORE, ".tmp-codegen-"))
	made.push(dir)
	const all = { "package.json": JSON.stringify({ name: "app", private: true, type: "module" }), ...files }
	for (const [name, text] of Object.entries(all)) {
		fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
		fs.writeFileSync(path.join(dir, name), text)
	}
	return dir
}

const tables = (name: string) => `import { sqliteTable } from "drizzle-orm/sqlite-core"
import { c } from "@lovrozagar/comb/sqlite/columns"
export const ${name}Item = sqliteTable("${name}_item", { id: c.id("it${name}"), name: c.text("name").notNull() })
`

async function codegen(dir: string): Promise<void> {
	const errors: string[] = []
	const io = { cwd: dir, err: (line: string) => errors.push(line), out: () => undefined }
	expect(await runCli(["codegen"], io), errors.join("\n")).toBe(0)
}

const read = (dir: string, file: string) => fs.readFileSync(path.join(dir, file), "utf8")
const exportsOf = (dir: string) =>
	(JSON.parse(read(dir, "package.json")) as { exports: Record<string, string> }).exports

/** tsc over every generated file of the project under the strict flags a consumer may set: its imports must resolve */
function typecheck(dir: string): string {
	const generated = fs
		.readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".gen.ts"))
		.map((entry) => path.join(entry.parentPath, entry.name))
	fs.writeFileSync(
		path.join(dir, "tsconfig.json"),
		JSON.stringify({
			compilerOptions: {
				allowImportingTsExtensions: true,
				exactOptionalPropertyTypes: true,
				module: "preserve",
				moduleResolution: "bundler",
				noEmit: true,
				noFallthroughCasesInSwitch: true,
				noImplicitReturns: true,
				noPropertyAccessFromIndexSignature: true,
				noUncheckedIndexedAccess: true,
				noUnusedLocals: true,
				noUnusedParameters: true,
				skipLibCheck: true,
				strict: true,
				target: "esnext",
				verbatimModuleSyntax: true,
			},
			files: generated,
		}),
	)
	const ran = spawnSync("bunx", ["tsc", "-p", path.join(dir, "tsconfig.json")], { cwd: CORE, encoding: "utf8" })
	return `${ran.stdout}${ran.stderr}`.trim()
}

describe("comb codegen: two databases in one folder (D1)", () => {
	it("gives each database only the tables its own tables file declares", async () => {
		const dir = project({
			"comb.config.ts": `export default { databases: {
	core: { tables: "./src/db/db.core.tables.ts" },
	audit: { tables: "./src/db/db.audit.tables.ts" },
} }\n`,
			"src/db/db.audit.tables.ts": tables("audit"),
			"src/db/db.core.tables.ts": tables("core"),
		})
		await codegen(dir)
		const entities = (file: string) =>
			(JSON.parse(read(dir, file)) as { entities: Array<{ name: string }> }).entities.map(({ name }) => name)
		expect(entities("src/db/db.core.manifest.gen.json")).toEqual(["core_item"])
		expect(entities("src/db/db.audit.manifest.gen.json")).toEqual(["audit_item"])
		expect(read(dir, "src/db/db.core.entities.gen.ts")).not.toContain("auditItem")
	}, 120_000)
})

/** A config of databases each in its own folder, all writing into src/gen, in `order` */
const sharedOutput = (order: readonly string[]) =>
	`export default { databases: { ${order
		.map((name) => `${name}: { tables: "./src/${name}/db.${name}.tables.ts", output: { default: "./src/gen" } }`)
		.join(", ")} } }\n`

describe("comb codegen: two databases sharing one output and one package.json (D2, S6)", () => {
	it.each([[["core", "audit"]], [["audit", "core"]]])(
		"keeps each database's _shared file and exports, namespaced by database, in config order %j",
		async (order) => {
			const dir = project({
				"comb.config.ts": sharedOutput(order),
				"src/audit/db.audit.tables.ts": tables("audit"),
				"src/core/db.core.tables.ts": tables("core"),
			})
			await codegen(dir)
			const exports = exportsOf(dir)
			for (const db of ["core", "audit"]) {
				expect(exports[`./${db}/dtos/${db}-item`]).toBe(`./src/gen/dtos/${db}-item/db.${db}.${db}-item.gen.ts`)
				expect(exports[`./${db}/dtos/_shared`]).toBe(`./src/gen/dtos/_shared/db.${db}._shared.gen.ts`)
				expect(exports[`./${db}/entities`]).toBe(`./src/gen/db.${db}.entities.gen.ts`)
				expect(exports[`./${db}/field-names`]).toBe(`./src/gen/db.${db}.field-names.gen.ts`)
				expect(exports[`./${db}/tables`]).toBe(`./src/${db}/db.${db}.tables.ts`)
			}
			expect(Object.keys(exports).filter((key) => !/^\.\/(?:core|audit)\//.test(key))).toEqual([])
			expect(typecheck(dir)).toBe("")
		},
		180_000,
	)
})

describe("comb codegen: a database named apart from its tables file (D3)", () => {
	it.each([
		["with output.default", ', output: { default: "./src/gen" }', "src/gen"],
		["without it", "", "src/db"],
	])(
		"writes ORM and relations imports that resolve, %s",
		async (_, output, outDir) => {
			const dir = project({
				"comb.config.ts": `export default { databases: { main: { tables: "./src/db/db.core.tables.ts", dialect: "sqlite", driver: "d1"${output} } } }\n`,
				"src/db/db.core.tables.ts": tables("core"),
			})
			await codegen(dir)
			expect(fs.existsSync(path.join(dir, outDir, "db.main.orm.gen.ts"))).toBe(true)
			expect(exportsOf(dir)["./relations"]).toBe(`./${outDir}/db.main.relations.gen.ts`)
			expect(typecheck(dir)).toBe("")
		},
		180_000,
	)
})

/** A table name that breaks any string literal, block comment or SQL identifier written around it unescaped */
const HOSTILE = 'quo"ted */ \\ end'

describe("comb codegen: SQL names that are not plain identifiers", () => {
	it("writes every name it reads into valid TypeScript, comments and string literals alike", async () => {
		const dir = project({
			"comb.config.ts": `export default { databases: { core: { tables: "./src/db/db.core.tables.ts", fts: { ${JSON.stringify(HOSTILE)}: { columns: ["label"] } } } } }\n`,
			"src/db/db.core.tables.ts": `import { sqliteTable, uniqueIndex } from "drizzle-orm/sqlite-core"
import { c } from "@lovrozagar/comb/sqlite/columns"
export const account = sqliteTable("account", { id: c.id("acc") })
export const quoted = sqliteTable(${JSON.stringify(HOSTILE)}, {
	id: c.id("qt"),
	label: c.text('la"bel').notNull(),
	kind: c.enum("kind", ["a", "b"]).notNull(),
	ownerId: c.ref('own"er').notNull().references(() => account.id, { onDelete: "cascade" }),
}, (t) => [uniqueIndex("idx_label").on(t.label)])
`,
		})
		await codegen(dir)
		expect(typecheck(dir)).toBe("")
		const names = await import(path.join(dir, "src/db/table-names/db.core.table-names.gen.ts"))
		expect(names.t.quoted).toBe(HOSTILE)
	}, 180_000)

	it("writes a _shared file that typechecks when the database has no tables", async () => {
		const dir = project({
			"comb.config.ts": `export default { databases: { core: { tables: "./src/db/db.core.tables.ts" } } }\n`,
			"src/db/db.core.tables.ts": "export {}\n",
		})
		await codegen(dir)
		expect(typecheck(dir)).toBe("")
	}, 180_000)
})
