import fs from "node:fs"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { fixtureRoot } from "../__fixtures__/temp.ts"
import { writeSnapshot } from "./child.ts"

let dir: string

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(fixtureRoot(), "comb-child-"))
})

afterEach(() => fs.rmSync(dir, { force: true, recursive: true }))

const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>

describe("writeSnapshot", () => {
	it("writes the snapshot of the tables module, or the error that stopped it", async () => {
		const tables = path.join(dir, "db.core.tables.ts")
		const result = path.join(dir, "result.json")
		fs.writeFileSync(
			tables,
			`import { sqliteTable } from "drizzle-orm/sqlite-core"\nimport { c } from "@lovrozagar/comb/sqlite/columns"\nexport const note = sqliteTable("note", { id: c.id("not") })\n`,
		)
		await writeSnapshot([tables, result])
		expect((read(result)["snapshot"] as { tables: unknown[] }).tables).toHaveLength(1)
		const broken = path.join(dir, "db.broken.tables.ts")
		fs.writeFileSync(broken, `throw new Error("not import-safe")\n`)
		await writeSnapshot([broken, result])
		expect(read(result)).toEqual({ error: "not import-safe" })
		const thrown = path.join(dir, "db.thrown.tables.ts")
		fs.writeFileSync(thrown, `throw "a string"\n`)
		await writeSnapshot([thrown, result])
		expect(read(result)).toEqual({ error: "a string" })
	})

	it("refuses to run without both paths", async () => {
		await expect(writeSnapshot(["only"])).rejects.toThrow("writeSnapshot takes [tables, result]")
	})
})
