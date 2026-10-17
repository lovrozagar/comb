import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { validateTables } from "./validate.ts"

describe("validateTables: primary keys the helpers declare", () => {
	let dir: string

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-validate-pk-"))
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
	])("sees the primary key %s declares", (_name, columns) => {
		expect(validate(columns).warnings.filter((w) => w.includes("primary key"))).toEqual([])
	})

	it("still warns when there is none", () => {
		expect(validate('\tname: c.text("name"),').warnings.some((w) => w.includes("no primary key"))).toBe(true)
	})
})

describe("validateTables: keys, tenants and tables it cannot read", () => {
	let dir: string

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-validate-keys-"))
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

	it("warns that a primary key under another property cannot be cursor-paginated, unless it is composite", () => {
		const natural = validate(`export const country = sqliteTable("country", { code: c.text("code").primaryKey() })`)
		expect(natural.warnings.join("\n")).toContain('country: primary key is declared as "code"')
		const composite = validate(
			`export const m = sqliteTable("m", { a: c.text("a"), b: c.text("b") }, (t) => [primaryKey({ columns: [t.a, t.b] })])`,
		)
		expect(composite.warnings).toEqual([])
	})

	it("rejects two tenant columns on one table", () => {
		const result = validate(`export const t = sqliteTable("t", {
	id: c.id("ttt"),
	org_id: c.ref("org_id", { tenant: true }),
	team_id: c.ref("team_id", { tenant: true }),
})`)
		expect(result.errors).toEqual([
			"t: 2 columns declare { tenant: true } (org_id, team_id). A table scopes to at most one tenant column.",
		])
	})

	it("reports a table whose schema the generated DTOs could not import", () => {
		const result = validate(`import * as z from "zod"
const hidden = z.object({})
export const t = sqliteTable("t", { id: c.id("ttt"), prefs: c.json("prefs", hidden) })`)
		expect(result.errors.join("\n")).toContain('t: "hidden" is declared in')
	})

	it("rejects two tables under one variable name", () => {
		const result = validate(
			`export const t = sqliteTable("a", { id: c.id("aaa") })\nexport const t = sqliteTable("b", { id: c.id("bbb") })`,
		)
		expect(result.errors).toContain('Duplicate table variable name: "t"')
	})
})
