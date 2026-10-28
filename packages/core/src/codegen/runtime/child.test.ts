import fs from "node:fs"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { fixtureRoot } from "../__fixtures__/temp.ts"
import { projectFrame, writeSnapshot } from "./child.ts"

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
		expect(read(result)).toEqual({
			at: expect.stringMatching(/db\.broken\.tables\.ts:\d+:\d+$/),
			error: "not import-safe",
		})
		const thrown = path.join(dir, "db.thrown.tables.ts")
		fs.writeFileSync(thrown, `throw "a string"\n`)
		await writeSnapshot([thrown, result])
		expect(read(result)).toEqual({ error: "a string" })
	})

	/* F64: a throw in a module the tables file imports names that module, not the tables file alone */
	it("carries the first frame of the project's own code that threw", async () => {
		const result = path.join(dir, "result.json")
		fs.writeFileSync(path.join(dir, "helper.ts"), 'export const x = 1\nthrow new Error("helper is not import-safe")\n')
		const tables = path.join(dir, "db.core.tables.ts")
		fs.writeFileSync(tables, 'import { x } from "./helper.ts"\nexport const y = x\n')
		await writeSnapshot([tables, result])
		const { at, error } = read(result) as { at: string; error: string }
		expect(error).toBe("helper is not import-safe")
		expect(at).toMatch(/helper\.ts:\d+:\d+$/)
	})

	it("refuses to run without both paths", async () => {
		await expect(writeSnapshot(["only"])).rejects.toThrow("writeSnapshot takes [tables, result]")
	})
})

/** An error whose stack is `frames` */
const thrownAt = (...frames: string[]) => Object.assign(new Error("e"), { stack: ["Error: e", ...frames].join("\n") })

describe("projectFrame", () => {
	const comb = path.resolve(import.meta.dirname, "load.ts")

	it("skips a package's frames and comb's own, and reads a file URL as its path", () => {
		const error = thrownAt(
			"    at run (/p/node_modules/drizzle-orm/index.js:1:2)",
			`    at load (${comb}:3:4)`,
			"    at file:///p/src/db/helper.ts:5:6",
		)
		expect(projectFrame(error)).toBe("/p/src/db/helper.ts:5:6")
		expect(projectFrame(thrownAt("    at named (/p/src/db/db.core.tables.ts:7:8)"))).toBe(
			"/p/src/db/db.core.tables.ts:7:8",
		)
	})

	it("is undefined where no frame is the project's, or there is no stack", () => {
		expect(
			projectFrame(thrownAt("    at run (/p/node_modules/x/index.js:1:2)", "    at node:internal/main:1:1")),
		).toBeUndefined()
		expect(projectFrame(Object.assign(new Error("e"), { stack: undefined }))).toBeUndefined()
		expect(projectFrame("a string")).toBeUndefined()
	})
})
