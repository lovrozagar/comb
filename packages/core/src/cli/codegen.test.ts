import { fixtureRoot } from "../codegen/__fixtures__/temp.ts"
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { makeIo, projects, runCliWithFakes, writeTables } from "./__fixtures__/io.ts"
import { GENERATORS } from "../codegen/config.ts"

const temp = projects(fixtureRoot())
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
		expect(await runCliWithFakes(["codegen"], io)).toBe(0)
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
		expect(await runCliWithFakes(["codegen"], makeIo(dir))).toBe(0)
		/* only the run record sits beside the config: every generated file is under output.default */
		expect(readdirSync(dir).filter((file) => file.includes(".gen."))).toEqual([".comb.codegen.gen.json"])
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

/* Q7 of r18: comb.config.ts's partitions reach the constraint map, on the parent's entry */
describe("comb codegen: a Postgres database's partitions", () => {
	it("writes each on its parent's entry in the constraint map", async () => {
		const dir = project()
		writeFileSync(
			join(dir, "db.core.tables.ts"),
			`import { pgTable, text } from "drizzle-orm/pg-core"\nexport const audit = pgTable("audit", { id: text("id").primaryKey() })\n`,
		)
		config(dir, { dialect: "postgres", generators: ["constraints"], partitions: { audit: ["audit_2026"] } })
		expect(await runCliWithFakes(["codegen"], makeIo(dir))).toBe(0)
		expect(readFileSync(join(dir, "db.core.constraints.gen.ts"), "utf8")).toContain(
			'\t\t/* partitions, whose violations Postgres reports in this table\'s place */\n\t\tpartitions: ["audit_2026"]',
		)
	})
})

describe("comb codegen: config mode names", () => {
	it("names the database as the config does, whatever its tables file is called", async () => {
		const dir = project()
		writeTables(dir, "schema.tables.ts")
		config(dir, { dialect: "sqlite", driver: "d1", tables: "./schema.tables.ts" })
		expect(await runCliWithFakes(["codegen"], makeIo(dir))).toBe(0)
		const constraints = readFileSync(join(dir, "db.core.constraints.gen.ts"), "utf8")
		expect(constraints).toContain("export const CORE_DB_CONSTRAINT_MAP")
		expect(readdirSync(join(dir, "diagrams"))).toContain("core-schema.gen.sql")
	})
})

describe("comb codegen: config mode generator selection", () => {
	it("honors the config's generators, output overrides, and -g for one generator", async () => {
		const dir = project()
		writeTables(dir)
		config(dir, { generators: ["rows", "manifest", "orm", "fts"], output: { rows: "./out/rows.gen.ts" } })
		expect(await runCliWithFakes(["codegen", "core"], makeIo(dir))).toBe(0)
		/* orm without a dialect and driver, and fts without a config, write nothing */
		expect(readdirSync(dir).sort()).toEqual([
			".comb.codegen.gen.json",
			"comb.config.ts",
			"db.core.manifest.gen.json",
			"db.core.tables.ts",
			"out",
		])
		expect(existsSync(join(dir, "out", "rows.gen.ts"))).toBe(true)
		const one = project()
		writeTables(one)
		config(one, {})
		expect(await runCliWithFakes(["codegen", "-g", "manifest"], makeIo(one))).toBe(0)
		expect(readdirSync(one).sort()).toEqual([
			".comb.codegen.gen.json",
			"comb.config.ts",
			"db.core.manifest.gen.json",
			"db.core.tables.ts",
		])
	})
})

describe("comb codegen: config mode errors", () => {
	it("reports a missing comb.config.ts in config mode", async () => {
		const io = makeIo(project())
		expect(await runCliWithFakes(["codegen"], io)).toBe(1)
		expect(io.errors).toEqual(["No comb.config.ts found. Create one or use --tables <path> for direct mode."])
	})

	it("refuses a database the config does not declare", async () => {
		const dir = project()
		config(dir, {})
		const io = makeIo(dir)
		expect(await runCliWithFakes(["codegen", "blog"], io)).toBe(1)
		expect(io.errors).toEqual(['comb.config.ts declares no database "blog". Available: core'])
	})
})

describe("comb codegen: direct mode", () => {
	it("runs the direct generators beside the tables file, named after the analyzed database", async () => {
		const dir = project()
		writeTables(dir)
		const io = makeIo(dir)
		expect(await runCliWithFakes(["codegen", "--tables", "db.core.tables.ts"], io)).toBe(0)
		expect(io.outputs[0]).toBe("Analyzed 1 tables (core)")
		const files = readdirSync(dir)
		expect(files).toContain("db.core.enum-checks.gen.ts")
		expect(files).not.toContain("db.core.field-names.gen.ts")
	})

	/* K2 of r19: a database named beside --tables was dropped, and direct mode wrote its files anyway */
	it.each([
		[["codegen", "core", "--tables", "db.core.tables.ts"]],
		[["codegen", "--tables", "db.core.tables.ts", "nonexistent-db", "another"]],
	])("refuses a database beside --tables, %j, writing nothing", async (argv) => {
		const dir = project()
		writeTables(dir)
		const before = readdirSync(dir)
		const io = makeIo(dir)
		expect(await runCliWithFakes(argv, io)).toBe(1)
		expect(io.errors).toEqual(["Usage: comb codegen --tables <path> [-g <name>]"])
		expect(readdirSync(dir)).toEqual(before)
	})

	it("reports a missing tables file in direct codegen mode, relative to cwd", async () => {
		const dir = project()
		const io = makeIo(dir)
		expect(await runCliWithFakes(["codegen", "--tables", "db.tables.ts"], io)).toBe(1)
		expect(io.errors).toEqual([`Tables file not found: ${join(dir, "db.tables.ts")}`])
	})

	it("stops on validation errors and passes warnings on", async () => {
		const dir = project()
		writeFileSync(
			join(dir, "bad.tables.ts"),
			'import { sqliteTable, text } from "drizzle-orm/sqlite-core"\nexport const a = sqliteTable("t", { id: text("id").primaryKey() })\nexport const b = sqliteTable("t", { id: text("id").primaryKey() })\n',
		)
		const failed = makeIo(dir)
		expect(await runCliWithFakes(["codegen", "--tables", "bad.tables.ts"], failed)).toBe(1)
		expect(failed.errors.slice(0, 2)).toEqual([
			"Nothing was written: codegen writes every database's files once all of them succeed",
			expect.stringMatching(/^Validation errors:\n {2}/),
		])
		/* the analyzer reads the whole directory, so the warning case gets its own */
		const other = project()
		writeFileSync(
			join(other, "warn.tables.ts"),
			'import { sqliteTable, text } from "drizzle-orm/sqlite-core"\nexport const t = sqliteTable("t", { name: text("name") })\n',
		)
		const warned = makeIo(other)
		expect(await runCliWithFakes(["codegen", "--tables", "warn.tables.ts", "-g", "rows"], warned)).toBe(0)
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
			expect(await runCliWithFakes(argv, io)).toBe(1)
			expect(io.errors.join("\n")).toContain(message)
		}
	})
})

const HEAD = `import { sqliteTable } from "drizzle-orm/sqlite-core"
import { c } from "@lovrozagar/comb/sqlite/columns"
`
const POST = `export const post = sqliteTable("post", { id: c.id("pst"), title: c.text("title").notNull() })\n`
const INVOICE = `export const invoice = sqliteTable("invoice", { id: c.id("inv"), total: c.integer("total") })\n`

/** Every file under `dir`, relative to it, sorted */
function filesUnder(dir: string, base = dir): string[] {
	return readdirSync(dir, { withFileTypes: true })
		.flatMap((entry) =>
			entry.isDirectory() ? filesUnder(join(dir, entry.name), base) : [join(dir, entry.name).slice(base.length + 1)],
		)
		.sort()
}

describe("comb codegen: what a run leaves on disk (F12, F19)", () => {
	it("writes nothing when a table fails, so the output is the last good run's or none (F19)", async () => {
		const dir = project()
		config(dir, { output: { default: "./gen" } })
		writeFileSync(
			join(dir, "db.core.tables.ts"),
			`${HEAD}${POST}export const bad = sqliteTable("bad", { id: c.id("bad"), s: c.enum("s", valuesOf()) })\n`,
		)
		const io = makeIo(dir)
		expect(await runCliWithFakes(["codegen"], io)).toBe(1)
		expect(existsSync(join(dir, "gen"))).toBe(false)
		expect(filesUnder(dir).filter((file) => file.endsWith(".tmp"))).toEqual([])
	})

	/* KC10 of r22b: a run that failed printed "Generated … at:" for the files of the database before the broken one */
	it("prints what it generated only once it is written, and that nothing was when a database fails", async () => {
		const dir = project()
		writeTables(dir, "a.tables.ts")
		writeFileSync(
			join(dir, "b.tables.ts"),
			`${HEAD}${POST}export const bad = sqliteTable("bad", { id: c.id("bad"), s: c.enum("s", valuesOf()) })\n`,
		)
		const both =
			'{ a: { tables: "./a.tables.ts", output: { default: "./gen/a" } }, b: { tables: "./b.tables.ts", output: { default: "./gen/b" } } }'
		writeFileSync(join(dir, "comb.config.ts"), `export default { databases: ${both} }\n`)
		const io = makeIo(dir)
		expect(await runCliWithFakes(["codegen"], io)).toBe(1)
		/* each database's header, which stays true (AD3 of the area D review), and nothing it generated */
		expect(io.outputs).toEqual(["\nCodegen: a", "\nCodegen: b"])
		expect(io.errors).toContain("Nothing was written: codegen writes every database's files once all of them succeed")
		expect(existsSync(join(dir, "gen"))).toBe(false)
		const good = makeIo(dir)
		expect(await runCliWithFakes(["codegen", "a"], good)).toBe(0)
		expect(good.outputs.slice(0, 2)).toEqual(["\nCodegen: a", "  1 tables"])
		expect(good.outputs).toContain(`Generated rows at: ${join(dir, "gen/a/db.a.rows.gen.ts")}`)
	})

	it("deletes the files of a table that is gone, and of a generator that writes nothing now, but no file it did not write (F12)", async () => {
		const dir = project()
		config(dir, { output: { default: "./gen" } })
		writeFileSync(join(dir, "db.core.tables.ts"), `${HEAD}${POST}${INVOICE}`)
		expect(await runCliWithFakes(["codegen"], makeIo(dir))).toBe(0)
		expect(filesUnder(join(dir, "gen")).some((file) => file.includes("invoice"))).toBe(true)
		writeFileSync(join(dir, "gen", "dtos", "keep.ts"), "export const mine = 1\n")
		/* a stale file someone removed already, and one someone made their own, are left as they are */
		const [removed, owned] = filesUnder(join(dir, "gen")).filter((file) => file.includes("invoice")) as [string, string]
		rmSync(join(dir, "gen", removed))
		writeFileSync(join(dir, "gen", owned), "export const mine = 2\n")
		writeFileSync(join(dir, "db.core.tables.ts"), `${HEAD}${POST}`)
		expect(await runCliWithFakes(["codegen"], makeIo(dir))).toBe(0)
		const after = filesUnder(join(dir, "gen"))
		expect(after.filter((file) => file.includes("invoice"))).toEqual([owned])
		expect(after).toContain("dtos/keep.ts")
		expect(readFileSync(join(dir, "gen", "db.core.rows.gen.ts"), "utf8")).not.toContain("invoice")
		/* a run of one generator deletes nothing another wrote */
		expect(await runCliWithFakes(["codegen", "-g", "rows"], makeIo(dir))).toBe(0)
		expect(filesUnder(join(dir, "gen"))).toEqual(after)
	})
})

describe("comb codegen: the dialect of a tables file", () => {
	it("reads Postgres from comb's pg columns when the config names no dialect", async () => {
		const dir = project()
		config(dir, { generators: ["enum-checks"] })
		writeFileSync(
			join(dir, "db.core.tables.ts"),
			`import { pgTable } from "drizzle-orm/pg-core"\nimport { c } from "@lovrozagar/comb/pg/columns"\nexport const post = pgTable("post", { id: c.id("pst"), s: c.enum("s", ["a", "b"]) })\n`,
		)
		expect(await runCliWithFakes(["codegen"], makeIo(dir))).toBe(0)
		expect(readFileSync(join(dir, "db.core.enum-checks.gen.ts"), "utf8")).toContain('from "drizzle-orm/pg-core"')
	})
})

describe("comb codegen: a config dialect the tables contradict (F18)", () => {
	it("fails naming both, rather than generate SQLite code for Postgres tables", async () => {
		const dir = project()
		config(dir, { dialect: "sqlite", generators: ["enum-checks"] })
		writeFileSync(
			join(dir, "db.core.tables.ts"),
			`import { pgTable } from "drizzle-orm/pg-core"\nimport { c } from "@lovrozagar/comb/pg/columns"\nexport const post = pgTable("post", { id: c.id("pst"), s: c.enum("s", ["a", "b"]) })\n`,
		)
		const io = makeIo(dir)
		expect(await runCliWithFakes(["codegen"], io)).toBe(1)
		expect(io.errors.join("\n")).toMatch(
			/core: comb\.config\.ts says dialect sqlite, but db\.core\.tables\.ts declares postgres tables/,
		)
		expect(existsSync(join(dir, "db.core.enum-checks.gen.ts"))).toBe(false)
	})
})

/* the 0.12 review's F26: a database named twice ran twice into one staged map, and its record emptied */
describe("comb codegen: a database named twice (F26)", () => {
	it("runs it once, so its record still lists every file it writes", async () => {
		const dir = project()
		writeTables(dir)
		config(dir, {})
		expect(await runCliWithFakes(["codegen"], makeIo(dir))).toBe(0)
		const entries = () =>
			(JSON.parse(readFileSync(join(dir, ".comb.codegen.gen.json"), "utf8")) as { databases: Record<string, string[]> })
				.databases["core"]?.length
		const before = entries()
		const io = makeIo(dir)
		expect(await runCliWithFakes(["codegen", "core", "core"], io)).toBe(0)
		expect(entries()).toBe(before)
		expect(io.outputs.filter((line) => line === "\nCodegen: core")).toHaveLength(1)
	})
})

/* the 0.12 review's F32: -g named a generator the run does not run, and it exited 0, writing nothing */
describe("comb codegen: -g for a generator no database runs (F32)", () => {
	it("refuses it, naming the generators the run does run", async () => {
		const dir = project()
		const tables = writeTables(dir)
		const io = makeIo(dir)
		expect(await runCliWithFakes(["codegen", "--tables", tables, "-g", "orm"], io)).not.toBe(0)
		expect(io.errors.join("\n")).toMatch(/^codegen does not run orm here; it runs /)
		config(dir, { generators: ["rows"] })
		const configured = makeIo(dir)
		expect(await runCliWithFakes(["codegen", "-g", "orm"], configured)).not.toBe(0)
		expect(configured.errors.join("\n")).toBe("codegen does not run orm here; it runs rows")
	})
})

/** A tables file whose one table has no primary key, which codegen warns of and runs */
const WARNED = `import { sqliteTable, text } from "drizzle-orm/sqlite-core"\nexport const t = sqliteTable("t", { name: text("name") })\n`

/** A run of `argv` whose out and err lines land in one list, in the order said, each tagged with its stream */
async function said(dir: string, argv: readonly string[]) {
	const lines: string[] = []
	const io = {
		...makeIo(dir),
		err: (line: string) => lines.push(`err ${line}`),
		out: (line: string) => lines.push(`out ${line}`),
	}
	return { code: await runCliWithFakes(argv, io), lines }
}

/** Databases a and b, each a WARNED tables file, writing into ./gen/a and ./gen/b, or both into ./gen as app */
function warnedPair(dir: string, shared = false): void {
	writeFileSync(join(dir, "a.tables.ts"), WARNED)
	writeFileSync(join(dir, "b.tables.ts"), WARNED)
	const own = (name: string) =>
		shared ? { filePrefix: "app", output: { default: "./gen" } } : { output: { default: `./gen/${name}` } }
	const databases = { a: { ...own("a"), tables: "./a.tables.ts" }, b: { ...own("b"), tables: "./b.tables.ts" } }
	writeFileSync(join(dir, "comb.config.ts"), `export default { databases: ${JSON.stringify(databases)} }\n`)
}

/** A "Codegen: <db>" header or a warning, as `said` tags it */
const headerOrWarning = (line: string) => line.startsWith("out \nCodegen: ") || line.startsWith("err   warn: ")

/* KC10n: KC10 held out but not err, so every database's warnings came before any "Codegen: <db>" header */
describe("codegen says each warning under its database (KC10n; siblings: a failed run, a refused write)", () => {
	it("prints each database's warnings after its own header, in the order said", async () => {
		const dir = project()
		warnedPair(dir)
		const { code, lines } = await said(dir, ["codegen", "-g", "rows"])
		expect(code).toBe(0)
		expect(lines.filter(headerOrWarning).map((line) => line.replace(/warn: .*/, "warn"))).toEqual([
			"out \nCodegen: a",
			"err   warn",
			"out \nCodegen: b",
			"err   warn",
		])
	})

	it("prints the warnings it held, then that nothing was written, when a later database fails", async () => {
		const dir = project()
		warnedPair(dir)
		writeFileSync(join(dir, "b.tables.ts"), `${HEAD}${POST}${POST.replace("post =", "again =")}`)
		const { code, lines } = await said(dir, ["codegen", "-g", "rows"])
		expect(code).toBe(1)
		/* AD3 of the area D review: a header is true whether or not anything was written, so the warnings and the error keep theirs */
		expect(lines.filter((line) => line.startsWith("out "))).toEqual(["out \nCodegen: a", "out \nCodegen: b"])
		const nothing = lines.indexOf(
			"err Nothing was written: codegen writes every database's files once all of them succeed",
		)
		expect(lines.indexOf("out \nCodegen: a")).toBeLessThan(lines.findIndex((line) => line.startsWith("err   warn: ")))
		expect(lines.findIndex((line) => line.startsWith("err   warn: "))).toBeLessThan(lines.indexOf("out \nCodegen: b"))
		expect(lines.indexOf("out \nCodegen: b")).toBeLessThan(nothing)
		expect(existsSync(join(dir, "gen"))).toBe(false)
	})

	it("prints the warnings it held, and none of what it generated, when the write is refused", async () => {
		const dir = project()
		warnedPair(dir, true)
		const { code, lines } = await said(dir, ["codegen", "-g", "rows"])
		expect(code).toBe(1)
		expect(lines.filter(headerOrWarning).map((line) => line.replace(/warn: .*/, "warn"))).toEqual([
			"out \nCodegen: a",
			"err   warn",
			"out \nCodegen: b",
			"err   warn",
		])
		expect(lines.filter((line) => line.startsWith("out "))).toEqual(["out \nCodegen: a", "out \nCodegen: b"])
		expect(lines.at(-1)).toMatch(
			/^err databases a and b both write gen\/app\.rows\.gen\.ts; give each its own filePrefix or output$/,
		)
	})
})
