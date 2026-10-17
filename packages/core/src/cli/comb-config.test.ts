import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { makeIo, projects, writeTables } from "./__fixtures__/io.ts"
import { configuredFtsSql, databaseIn, findCombConfig, loadCombConfig, tablesFile } from "./comb-config.ts"
import { CliError } from "./output.ts"

const temp = projects()
const project = temp.make
afterEach(temp.clean)

describe("findCombConfig and loadCombConfig", () => {
	it("reads comb.config.ts, then comb.config.js, by default or namespace export", async () => {
		const ts = project()
		writeFileSync(join(ts, "comb.config.ts"), 'export default { databases: { core: { tables: "./a.ts" } } }\n')
		expect(await findCombConfig(ts)).toEqual({ databases: { core: { tables: "./a.ts" } } })
		const js = project()
		writeFileSync(join(js, "comb.config.js"), 'export const databases = { core: { tables: "./b.ts" } }\n')
		expect((await loadCombConfig(js)).databases).toEqual({ core: { tables: "./b.ts" } })
	})

	it("finds nothing in a project without one, and loading it then is an error", async () => {
		const empty = project()
		expect(await findCombConfig(empty)).toBeUndefined()
		await expect(loadCombConfig(empty)).rejects.toThrow(CliError)
	})
})

describe("databaseIn and tablesFile", () => {
	it("returns the declared database, and names the declared ones when it is not there", () => {
		const config = { databases: { core: { tables: "t.ts" } } }
		expect(databaseIn(config, "core")).toEqual({ tables: "t.ts" })
		expect(() => databaseIn(config, "nope")).toThrow('comb.config.ts declares no database "nope". Available: core')
		expect(() => databaseIn(config, "toString")).toThrow(CliError)
	})

	it("resolves a tables file against the project, and refuses one that is missing", () => {
		const dir = project()
		const file = writeTables(dir)
		expect(tablesFile(dir, "db.core.tables.ts")).toBe(file)
		expect(() => tablesFile(dir, "gone.ts")).toThrow(`Tables file not found: ${join(dir, "gone.ts")}`)
	})
})

describe("configuredFtsSql", () => {
	it("has no FTS without a config, a database name, or fts on the database", async () => {
		const dir = project()
		const io = makeIo(dir)
		expect(await configuredFtsSql(dir, "core", io)).toBeUndefined()
		writeFileSync(
			join(dir, "comb.config.ts"),
			'export default { databases: { core: { tables: "./db.core.tables.ts", fts: {} } } }\n',
		)
		expect(await configuredFtsSql(dir, undefined, io)).toBeUndefined()
		expect(await configuredFtsSql(dir, "core", io)).toBeUndefined()
	})

	it("is the FTS5 DDL the database's fts config declares", async () => {
		const dir = project()
		writeTables(dir)
		writeFileSync(
			join(dir, "comb.config.ts"),
			'export default { databases: { core: { tables: "./db.core.tables.ts", fts: { post: { columns: ["title"] } } } } }\n',
		)
		expect(await configuredFtsSql(dir, "core", makeIo(dir))).toMatch(
			/CREATE VIRTUAL TABLE IF NOT EXISTS post_fts USING fts5/,
		)
	})
})
