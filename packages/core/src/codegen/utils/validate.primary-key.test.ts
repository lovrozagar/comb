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
