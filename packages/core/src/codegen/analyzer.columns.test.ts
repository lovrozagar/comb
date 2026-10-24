import { fixtureRoot } from "./__fixtures__/temp.ts"
import fs from "node:fs"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { analyze } from "./analyzer.ts"
import type { FieldMeta } from "./analyzer-types.ts"

describe("analyzer: column facts the helpers hide", () => {
	let dir: string

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(fixtureRoot(), "comb-analyzer-columns-"))
	})

	afterEach(() => {
		fs.rmSync(dir, { force: true, recursive: true })
	})

	function fieldsOf(columns: string): FieldMeta[] {
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
		return analyze(file).tables[0]?.fields ?? []
	}

	it("c.serialId() is the primary key, and so not null", () => {
		const [id] = fieldsOf(`\tid: c.serialId(),`)
		expect(id).toMatchObject({ isNotNull: true, isPrimaryKey: true, name: "id", sqlName: "id" })
	})

	it("c.id(prefix) is the primary key", () => {
		const [id] = fieldsOf(`\tid: c.id("tsk"),`)
		expect(id).toMatchObject({ isNotNull: true, isPrimaryKey: true })
	})
})
