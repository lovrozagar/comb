import { existsSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { makeIo, projects, writeTables } from "./__fixtures__/io.ts"
import { GENERATORS } from "../codegen/config.ts"
import { runCli } from "./run.ts"

const temp = projects()
const project = temp.make
afterEach(temp.clean)

function config(dir: string, core: Record<string, unknown>): void {
	writeFileSync(
		join(dir, "comb.config.ts"),
		`export default { databases: { core: ${JSON.stringify({ tables: "./db.core.tables.ts", ...core })} } }\n`,
	)
}

describe("comb codegen: config mode", () => {
	it("runs every generator, in order, beside the tables file under the file prefix", async () => {
		const dir = project()
		writeTables(dir)
		config(dir, { dialect: "sqlite", driver: "d1", filePrefix: "app", fts: { post: { columns: ["title"] } } })
		const io = makeIo(dir)
		expect(await runCli(["codegen"], io)).toBe(0)
		expect(io.outputs.slice(0, 2)).toEqual(["\nCodegen: core", "  1 tables"])
		const files = readdirSync(dir)
		for (const suffix of [
			"constraints.gen.ts",
			"rows.gen.ts",
			"relations.gen.ts",
			"entities.gen.ts",
			"manifest.gen.json",
			"field-names.gen.ts",
			"orm.gen.ts",
			"enum-checks.gen.ts",
			"error-keys.gen.ts",
			"fts.gen.sql",
		]) {
			expect(files, suffix).toContain(`app.${suffix}`)
		}
		expect(files).toEqual(
			expect.arrayContaining(["dtos", "diagrams", "rqb-cols", "sql-cols", "table-names", "translations"]),
		)
	})

	it("writes under output.default, as the README shows, with a generator's own key still first", async () => {
		const dir = project()
		writeTables(dir)
		config(dir, {
			dialect: "sqlite",
			driver: "d1",
			fts: { post: { columns: ["title"] } },
			output: { default: "./gen", rows: "./elsewhere/rows.gen.ts" },
		})
		expect(await runCli(["codegen"], makeIo(dir))).toBe(0)
		expect(readdirSync(dir).filter((file) => file.includes(".gen."))).toEqual([])
		const gen = readdirSync(join(dir, "gen"))
		for (const file of [
			"db.core.constraints.gen.ts",
			"db.core.orm.gen.ts",
			"db.core.fts.gen.sql",
			"dtos",
			"diagrams",
			"translations",
		]) {
			expect(gen, file).toContain(file)
		}
		expect(existsSync(join(dir, "elsewhere", "rows.gen.ts"))).toBe(true)
	})
})

describe("comb codegen: config mode generator selection", () => {
	it("honors the config's generators, output overrides, and -g for one generator", async () => {
		const dir = project()
		writeTables(dir)
		config(dir, { generators: ["rows", "manifest", "orm", "fts"], output: { rows: "./out/rows.gen.ts" } })
		expect(await runCli(["codegen", "core"], makeIo(dir))).toBe(0)
		/* orm without a dialect and driver, and fts without a config, write nothing */
		expect(readdirSync(dir).sort()).toEqual(["comb.config.ts", "db.core.manifest.gen.json", "db.core.tables.ts", "out"])
		expect(existsSync(join(dir, "out", "rows.gen.ts"))).toBe(true)
		const one = project()
		writeTables(one)
		config(one, {})
		expect(await runCli(["codegen", "-g", "manifest"], makeIo(one))).toBe(0)
		expect(readdirSync(one).sort()).toEqual(["comb.config.ts", "db.core.manifest.gen.json", "db.core.tables.ts"])
	})
})

describe("comb codegen: config mode errors", () => {
	it("reports a missing comb.config.ts in config mode", async () => {
		const io = makeIo(project())
		expect(await runCli(["codegen"], io)).toBe(1)
		expect(io.errors).toEqual(["No comb.config.ts found. Create one or use --tables <path> for direct mode."])
	})

	it("refuses a database the config does not declare", async () => {
		const dir = project()
		config(dir, {})
		const io = makeIo(dir)
		expect(await runCli(["codegen", "blog"], io)).toBe(1)
		expect(io.errors).toEqual(['comb.config.ts declares no database "blog". Available: core'])
	})
})

describe("comb codegen: direct mode", () => {
	it("runs the direct generators beside the tables file, named after the analyzed database", async () => {
		const dir = project()
		writeTables(dir)
		const io = makeIo(dir)
		expect(await runCli(["codegen", "--tables", "db.core.tables.ts"], io)).toBe(0)
		expect(io.outputs[0]).toBe("Analyzed 1 tables (core)")
		const files = readdirSync(dir)
		expect(files).toContain("db.core.enum-checks.gen.ts")
		expect(files).not.toContain("db.core.field-names.gen.ts")
	})

	it("reports a missing tables file in direct codegen mode, relative to cwd", async () => {
		const dir = project()
		const io = makeIo(dir)
		expect(await runCli(["codegen", "--tables", "db.tables.ts"], io)).toBe(1)
		expect(io.errors).toEqual([`Tables file not found: ${join(dir, "db.tables.ts")}`])
	})

	it("stops on validation errors and passes warnings on", async () => {
		const dir = project()
		writeFileSync(
			join(dir, "bad.tables.ts"),
			'import { sqliteTable, text } from "drizzle-orm/sqlite-core"\nexport const a = sqliteTable("t", { id: text("id").primaryKey() })\nexport const b = sqliteTable("t", { id: text("id").primaryKey() })\n',
		)
		const failed = makeIo(dir)
		expect(await runCli(["codegen", "--tables", "bad.tables.ts"], failed)).toBe(1)
		expect(failed.errors[0]).toMatch(/^Validation errors:\n {2}/)
		/* the analyzer reads the whole directory, so the warning case gets its own */
		const other = project()
		writeFileSync(
			join(other, "warn.tables.ts"),
			'import { sqliteTable, text } from "drizzle-orm/sqlite-core"\nexport const t = sqliteTable("t", { name: text("name") })\n',
		)
		const warned = makeIo(other)
		expect(await runCli(["codegen", "--tables", "warn.tables.ts", "-g", "rows"], warned)).toBe(0)
		expect(warned.errors.some((line) => line.startsWith("  warn: "))).toBe(true)
	})
})

describe("comb codegen: arguments", () => {
	it("refuses -g without a generator, an unknown generator and an unknown option (S-13)", async () => {
		const dir = project()
		writeTables(dir, "t.ts")
		const cases: Array<[string[], string]> = [
			[["codegen", "--tables", "t.ts", "-g"], "-g needs a value"],
			[["codegen", "--tables", "t.ts", "-g", "nope"], `Unknown generator: nope. Known: ${GENERATORS.join(", ")}`],
			[["codegen", "--tables", "t.ts", "--frobnicate"], "Unknown option: --frobnicate"],
		]
		for (const [argv, message] of cases) {
			const io = makeIo(dir)
			expect(await runCli(argv, io)).toBe(1)
			expect(io.errors.join("\n")).toContain(message)
		}
	})
})
