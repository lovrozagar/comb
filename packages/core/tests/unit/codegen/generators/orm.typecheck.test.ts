import fs from "node:fs"
import path from "node:path"
import { Project, ts } from "ts-morph"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { generateOrm } from "../../../../src/codegen/generators/orm.ts"

/* Generated clients must compile against the drizzle-orm comb ships with — a
   string assertion can't catch a config key drizzle dropped. The scratch dir
   sits inside the package so drizzle-orm and @libsql/client resolve. */
const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../../../..")

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

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(PACKAGE_ROOT, ".tmp-orm-typecheck-"))
		fs.writeFileSync(path.join(tmpDir, "db.core.tables.ts"), TABLES)
		fs.writeFileSync(path.join(tmpDir, "db.core.relations.gen.ts"), RELATIONS)
	})

	afterEach(() => {
		fs.rmSync(tmpDir, { force: true, recursive: true })
	})

	function diagnostics(driver: "bun-sqlite" | "d1" | "libsql" | "turso"): string[] {
		const outputPath = path.join(tmpDir, "orm.gen.ts")
		generateOrm(path.join(tmpDir, "db.core.tables.ts"), { dialect: "sqlite", driver, output: outputPath }, tmpDir)
		const project = new Project({
			compilerOptions: {
				module: 99,
				moduleResolution: 100,
				noEmit: true,
				skipLibCheck: true,
				strict: true,
				target: 99,
				types: ["bun-types", "@cloudflare/workers-types"],
			},
		})
		project.addSourceFilesAtPaths(path.join(tmpDir, "*.ts"))
		return project.getPreEmitDiagnostics().map((d) => {
			const text = ts.flattenDiagnosticMessageText(d.compilerObject.messageText, "\n")
			return `${d.getSourceFile()?.getBaseName() ?? "?"}: ${text}`.slice(0, 300)
		})
	}

	it.each(["d1", "turso", "libsql", "bun-sqlite"] as const)("%s client typechecks", (driver) => {
		expect(diagnostics(driver)).toEqual([])
	})
})
