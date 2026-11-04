import { fixtureRoot } from "../__fixtures__/temp.ts"
import fs from "node:fs"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { analyze } from "../analyzer.ts"
import { validateTables as validateAnalysis } from "./validate.ts"

/** The validation of the tables file `file`, read at runtime as codegen reads it */
const validateTables = async (file: string) => validateAnalysis(await analyze(file))

describe("validateTables: primary keys the helpers declare", () => {
	let dir: string

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(fixtureRoot(), "comb-validate-pk-"))
	})

	afterEach(() => {
		fs.rmSync(dir, { force: true, recursive: true })
	})

	function validate(columns: string) {
		const file = path.join(dir, "db.test.tables.ts")
		fs.writeFileSync(
			file,
			`import { sqliteTable } from "drizzle-orm/sqlite-core"
import { c } from "@lovrozagar/comb/sqlite/columns"
export const task = sqliteTable("task", {
${columns}
})
`,
		)
		return validateTables(file)
	}

	it.each([
		["c.serialId()", "\tid: c.serialId(),"],
		["c.id(prefix)", '\tid: c.id("tsk"),'],
	])("sees the primary key %s declares", async (_name, columns) => {
		expect((await validate(columns)).warnings.filter((w) => w.includes("primary key"))).toEqual([])
	})

	it("still warns when there is none", async () => {
		expect((await validate('\tname: c.text("name"),')).warnings.some((w) => w.includes("no primary key"))).toBe(true)
	})
})

describe("validateTables: keys, tenants and tables it cannot read", () => {
	let dir: string

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(fixtureRoot(), "comb-validate-keys-"))
	})

	afterEach(() => fs.rmSync(dir, { force: true, recursive: true }))

	function validate(source: string) {
		const file = path.join(dir, "db.test.tables.ts")
		fs.writeFileSync(
			file,
			`import { sqliteTable } from "drizzle-orm/sqlite-core"\nimport { c } from "@lovrozagar/comb/sqlite/columns"\n${source}`,
		)
		return validateTables(file)
	}

	it("warns that a primary key under another property cannot be cursor-paginated, unless it is composite", async () => {
		const natural = await validate(
			`export const country = sqliteTable("country", { code: c.text("code").primaryKey() })`,
		)
		expect(natural.warnings.join("\n")).toContain('country: primary key is declared as "code"')
		const composite = await validate(
			`export const m = sqliteTable("m", { a: c.text("a"), b: c.text("b") }, (t) => [primaryKey({ columns: [t.a, t.b] })])\nimport { primaryKey } from "drizzle-orm/sqlite-core"`,
		)
		expect(composite.warnings).toEqual([
			"m: composite primary key, so no entity stamp is published (docs/meta-contract.md §6.4)",
		])
	})

	it("rejects two tenant columns on one table", async () => {
		const result = await validate(`export const t = sqliteTable("t", {
	id: c.id("ttt"),
	org_id: c.ref("org_id", { tenant: true }),
	team_id: c.ref("team_id", { tenant: true }),
})`)
		expect(result.errors).toEqual([
			"t: 2 columns declare { tenant: true } (org_id, team_id). A table scopes to at most one tenant column.",
		])
	})

	it("refuses a table whose schema the generated DTOs could not import, as the module exports it nowhere", async () => {
		await expect(
			validate(`import * as z from "zod"
const hidden = z.object({})
export const t = sqliteTable("t", { id: c.id("ttt"), prefs: c.json("prefs", hidden) })`),
		).rejects.toThrow("t.prefs: no module of the project exports the schema its c.json is given")
	})

	it("refuses a module that declares one name twice, which does not load", async () => {
		await expect(
			validate(
				`export const t = sqliteTable("a", { id: c.id("aaa") })\nexport const t = sqliteTable("b", { id: c.id("bbb") })`,
			),
		).rejects.toThrow("comb could not load")
	})
})

describe("validateTables: composite keys (D2)", () => {
	it("warns that a table with a composite primary key publishes no entity stamp", async () => {
		const dir = fs.mkdtempSync(path.join(fixtureRoot(), "comb-validate-composite-"))
		try {
			const file = path.join(dir, "db.test.tables.ts")
			fs.writeFileSync(
				file,
				`import { sqliteTable } from "drizzle-orm/sqlite-core"\nimport { c } from "@lovrozagar/comb/sqlite/columns"\nexport const m = sqliteTable("m", { a: c.text("a"), b: c.text("b") }, (t) => [primaryKey({ columns: [t.a, t.b] })])\nimport { primaryKey } from "drizzle-orm/sqlite-core"`,
			)
			expect((await validateTables(file)).warnings).toEqual([
				"m: composite primary key, so no entity stamp is published (docs/meta-contract.md §6.4)",
			])
		} finally {
			fs.rmSync(dir, { force: true, recursive: true })
		}
	})
})
