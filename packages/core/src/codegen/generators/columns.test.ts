import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { analyze } from "../analyzer.ts"
import { generateColumns } from "./columns.ts"
import { testContext } from "./__fixtures__/context.ts"

const PRELUDE = `
import { sqliteTable as createTable, text } from "drizzle-orm/sqlite-core"
const c = {
	id: () => text("id").primaryKey(),
	text: (name: string, opts?: { private?: boolean }) => text(name),
}
`
const POST = `export const post = createTable("post", { id: c.id(), title: c.text("title") })`

type Options = Omit<Parameters<typeof generateColumns>[1], "output">

let tmpDir: string

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-gen-columns-"))
})

afterEach(() => {
	fs.rmSync(tmpDir, { force: true, recursive: true })
})

/** Generate into `<tmp>/output` from `body`; returns the progress lines */
function generate(body: string, opts: Options = {}): string[] {
	const tablesPath = path.join(tmpDir, "db.test.tables.ts")
	fs.writeFileSync(tablesPath, `${PRELUDE}${body}\n`)
	const ctx = testContext(analyze(tablesPath), { cwd: tmpDir, tablesPath })
	generateColumns(ctx, { output: "output", ...opts })
	return ctx.logged
}

const read = (...parts: string[]) => fs.readFileSync(path.join(tmpDir, "output", ...parts), "utf-8")
const writePkg = (exports: unknown) =>
	fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ exports, name: "app" }))
const readExports = () =>
	(JSON.parse(fs.readFileSync(path.join(tmpDir, "package.json"), "utf-8")) as { exports: Record<string, string> })
		.exports

describe("generateColumns", () => {
	it("generates rqb-cols, sql-cols and table-names", () => {
		const logged = generate(
			`export const user = createTable("user", { id: c.id(), name: c.text("name"), email: c.text("email") })`,
		)

		expect(read("rqb-cols", "user", "index.gen.ts")).toContain(
			"export const userRqbCols = {\n\temail: true,\n\tid: true,\n\tname: true,\n} as const",
		)
		const sql = read("sql-cols", "user", "index.gen.ts")
		expect(sql).toContain('import { user } from "../../../db.test.tables"')
		expect(sql).toContain("export const userSqlCols = {\n\temail: user.email,")
		expect(read("table-names", "index.gen.ts")).toContain('export const t = {\n\tuser: "user",\n} as const')
		expect(logged).toEqual(["Generated column refs for 1 tables"])
	})

	it("excludes private fields from column refs", () => {
		generate(
			`export const user = createTable("user", { id: c.id(), _secret: c.text("_secret", { private: true }), name: c.text("name") })`,
		)
		const rqb = read("rqb-cols", "user", "index.gen.ts")
		expect(rqb).toContain("name: true")
		expect(rqb).not.toContain("_secret")
	})

	it("names every file by the prefix when one is given", () => {
		generate(POST, { filePrefix: "app.db-test" })
		expect(read("rqb-cols", "post", "app.db-test.post.gen.ts")).toContain("postRqbCols")
		expect(read("sql-cols", "post", "app.db-test.post.gen.ts")).toContain("postSqlCols")
		expect(read("table-names", "app.db-test.table-names.gen.ts")).toContain('post: "post"')
	})
})

describe("generateColumns — package.json exports", () => {
	it("leaves package.json alone unless asked", () => {
		writePkg({ ".": "./x.ts" })
		generate(POST)
		expect(readExports()).toEqual({ ".": "./x.ts" })
	})

	it("does nothing when there is no package.json to update", () => {
		expect(() => generate(POST, { updatePackageJson: true })).not.toThrow()
		expect(fs.existsSync(path.join(tmpDir, "package.json"))).toBe(false)
	})

	it("registers rqb-cols, sql-cols and table-names per table, replacing its own stale entries", () => {
		writePkg({
			".": "./index.ts",
			"./rqb-cols/stale": "./gone.ts",
			"./sql-cols/stale": "./gone.ts",
			"./table-cols/stale": "./gone.ts",
			"./table-names": "./stale.ts",
			"./table-names-extra": "./kept.ts",
		})
		generate(POST, { updatePackageJson: true })
		expect(readExports()).toEqual({
			".": "./index.ts",
			"./rqb-cols/post": "./output/rqb-cols/post/index.gen.ts",
			"./sql-cols/post": "./output/sql-cols/post/index.gen.ts",
			"./table-names": "./output/table-names/index.gen.ts",
			"./table-names-extra": "./kept.ts",
		})
	})

	it("uses the file prefix in the generated export paths", () => {
		writePkg({})
		generate(POST, { filePrefix: "app.db-test", updatePackageJson: true })
		const exports = readExports()
		expect(exports["./rqb-cols/post"]).toBe("./output/rqb-cols/post/app.db-test.post.gen.ts")
		expect(exports["./table-names"]).toBe("./output/table-names/app.db-test.table-names.gen.ts")
	})

	it("keeps a single-target exports as the . export (S-13)", () => {
		writePkg("./index.ts")
		generate(POST, { updatePackageJson: true })
		expect(readExports()["."]).toBe("./index.ts")
	})
})
