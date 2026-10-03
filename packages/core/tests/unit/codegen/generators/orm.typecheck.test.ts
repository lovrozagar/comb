import fs from "node:fs"
import path from "node:path"
import { Project, ts } from "ts-morph"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { generateOrm } from "../../../../src/codegen/generators/orm.ts"

/* Generated clients must compile against the drizzle-orm comb ships with — a
   string assertion can't catch a config key drizzle dropped. The scratch dir
   sits inside the package so drizzle-orm and @libsql/client resolve. One
   program covers every driver; a program per driver is several seconds on CI. */
const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../../../..")
const DRIVERS = ["d1", "turso", "libsql", "bun-sqlite"] as const
const COMPILE_TIMEOUT_MS = 60_000

const TABLES = `import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const user = sqliteTable("user", {
	email: text("email").notNull(),
	id: text("id").primaryKey(),
	verified: integer("verified", { mode: "boolean" }).notNull(),
})
`

const RELATIONS = `import { defineRelations } from "drizzle-orm"
import * as schema from "./db.core.tables"

export const relations = defineRelations(schema, () => ({}))
`

describe("generateOrm — compiles against installed drizzle-orm", () => {
	let tmpDir: string
	const diagnosticsByDriver = new Map<string, string[]>()

	beforeAll(() => {
		tmpDir = fs.mkdtempSync(path.join(PACKAGE_ROOT, ".tmp-orm-typecheck-"))
		for (const driver of DRIVERS) {
			const dir = path.join(tmpDir, driver)
			fs.mkdirSync(dir)
			fs.writeFileSync(path.join(dir, "db.core.tables.ts"), TABLES)
			fs.writeFileSync(path.join(dir, "db.core.relations.gen.ts"), RELATIONS)
			generateOrm(
				path.join(dir, "db.core.tables.ts"),
				{ dialect: "sqlite", driver, output: path.join(dir, "orm.gen.ts") },
				dir,
			)
			diagnosticsByDriver.set(driver, [])
		}

		const project = new Project({
			compilerOptions: {
				module: ts.ModuleKind.ESNext,
				moduleResolution: ts.ModuleResolutionKind.Bundler,
				noEmit: true,
				skipLibCheck: true,
				strict: true,
				target: ts.ScriptTarget.ESNext,
				types: ["bun-types", "@cloudflare/workers-types"],
			},
		})
		project.addSourceFilesAtPaths(path.join(tmpDir, "*/*.ts"))
		for (const diagnostic of project.getPreEmitDiagnostics()) {
			const file = diagnostic.getSourceFile()?.getFilePath() ?? ""
			const driver = path.basename(path.dirname(file))
			const text = ts.flattenDiagnosticMessageText(diagnostic.compilerObject.messageText, "\n")
			const bucket = diagnosticsByDriver.get(driver)
			if (!bucket) throw new Error(`Diagnostic outside a driver dir: ${file}: ${text}`)
			bucket.push(`${path.basename(file)}: ${text}`.slice(0, 300))
		}
	}, COMPILE_TIMEOUT_MS)

	afterAll(() => {
		fs.rmSync(tmpDir, { force: true, recursive: true })
	})

	it.each(DRIVERS)("%s client typechecks", (driver) => {
		expect(diagnosticsByDriver.get(driver)).toEqual([])
	})
})
