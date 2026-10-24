import fs from "node:fs"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { sql } from "drizzle-orm"
import { integer, pgEnum, pgSchema, pgTable } from "drizzle-orm/pg-core"
import { check, integer as sqliteInteger, sqliteTable } from "drizzle-orm/sqlite-core"
import { c } from "../../sqlite/columns.ts"
import { analyzeNamespace } from "../__fixtures__/runtime.ts"
import { fixtureRoot } from "../__fixtures__/temp.ts"
import { readTables } from "./child.ts"
import { exportsHolding } from "./read-tables.ts"

let dir: string

/** An importer under which other.ts and zod do not load on their own */
const failingOn = (url: string) =>
	url.endsWith("other.ts") || url.includes("/zod/") ? Promise.reject(new Error("no")) : import(url)

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(fixtureRoot(), "comb-read-tables-"))
})

afterEach(() => fs.rmSync(dir, { force: true, recursive: true }))

const HEAD = `import { sqliteTable } from "drizzle-orm/sqlite-core"\nimport { c } from "@lovrozagar/comb/sqlite/columns"\n`

/** `files` written into the fixture directory, the tables file `db.core.tables.ts` among them */
function write(files: Record<string, string>): string {
	for (const [name, text] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
		fs.writeFileSync(path.join(dir, name), text)
	}
	return path.join(dir, "db.core.tables.ts")
}

describe("exportsHolding: where a value is exported, in a stable order", () => {
	it("puts a module other than the tables file first, then the shorter path, then the name (the A tie)", () => {
		const value = {}
		const loaded = [
			{ external: false, module: "/p/db.tables.ts", namespace: { a: value } },
			{ external: false, module: "/p/lib/long/schemas.ts", namespace: { s: value } },
			{ external: false, module: "/p/lib/b.ts", namespace: { z: value, y: value } },
			{ external: false, module: "/p/lib/a.ts", namespace: { x: value, other: {} } },
			{ external: true, module: "pkg", namespace: { w: value } },
		]
		expect(exportsHolding(value, loaded, "/p/db.tables.ts").map((at) => `${at.module}:${at.name}`)).toEqual([
			"pkg:w",
			"/p/lib/a.ts:x",
			"/p/lib/b.ts:y",
			"/p/lib/b.ts:z",
			"/p/lib/long/schemas.ts:s",
			"/p/db.tables.ts:a",
		])
	})
})

describe("readTables", () => {
	it("reads each exported table once, its schema found in a module and a package it imports", async () => {
		const tables = write({
			"db.core.tables.ts": `${HEAD}import * as z from "zod"
import { prefs } from "./schemas.ts"
import { ipList } from "comb-fixture-schemas"
import type { Unused } from "comb-fixture-types-only"
export const note = sqliteTable("note", { id: c.id("not"), prefs: c.json("prefs", prefs), ips: c.json("ips", ipList) })
export { note as alias }
export const plain = z.string()
`,
			"node_modules/comb-fixture-schemas/index.js": `import * as z from "zod"\nexport const ipList = z.array(z.string())\n`,
			"node_modules/comb-fixture-schemas/package.json": JSON.stringify({
				exports: "./index.js",
				name: "comb-fixture-schemas",
				type: "module",
			}),
			"schemas.ts": `import * as z from "zod"\nexport const prefs = z.object({ a: z.string() })\n`,
		})
		const { tables: read } = await readTables(tables)
		expect(read.map((table) => table.exportName)).toEqual(["alias"])
		const columns = Object.fromEntries((read[0]?.columns ?? []).map((column) => [column.key, column.comb?.schema]))
		expect(columns["prefs"]).toEqual({ external: false, module: path.join(dir, "schemas.ts"), name: "prefs" })
		expect(columns["ips"]).toEqual({ external: true, module: "comb-fixture-schemas", name: "ipList" })
	})

	it("skips a module that does not load on its own, and names it when a schema is then found nowhere", async () => {
		const tables = write({
			"db.core.tables.ts": `${HEAD}import * as z from "zod"
import { other } from "./other.ts"
export const note = sqliteTable("note", { id: c.id("not"), prefs: c.json("prefs", z.object({ other: z.literal(other) })) })
`,
			"other.ts": `export const other = "o"\n`,
		})
		await expect(readTables(tables, failingOn)).rejects.toThrow(
			`note.prefs: no module of the project exports the schema its c.json is given (${path.join(dir, "other.ts")}, zod would not load on their own)`,
		)
	})
})

/** A namespace exporting one table `t` of `columns` */
const oneTable = (columns: Record<string, unknown>) => ({ t: sqliteTable("t", columns as never) })

describe("snapshotOf: what a column or table cannot be", () => {
	it("refuses a constraint that is no boolean, number or string, a machine of another shape, and enum values not strings", () => {
		expect(() => analyzeNamespace(oneTable({ n: c.text("n", { max: [5] } as never) }))).toThrow(
			"t.n: the constraint max is a object; comb reads a boolean, a number or a string",
		)
		expect(() => analyzeNamespace(oneTable({ s: c.enum("s", ["a"], { initial: 1 } as never) }))).toThrow(
			"t.s: its state machine is not { initial?, terminal?, transitions? } of state names",
		)
		expect(() => analyzeNamespace(oneTable({ s: c.enum("s", [1] as never) }))).toThrow(
			"t.s: c.enum takes an array of strings",
		)
		expect(
			analyzeNamespace(oneTable({ n: c.text("n", { max: undefined }) })).tables[0]?.fields[0]?.constraints.max,
		).toBeNull()
	})

	it("refuses a key into a table the tables file does not export, naming where it is, or that it is nowhere", () => {
		const account = sqliteTable("account", { id: c.id("acc") })
		const note = sqliteTable("note", { accountId: c.ref("account_id").references(() => account.id) })
		expect(() => analyzeNamespace({ note }, { account })).toThrow(
			"note.accountId references the table account (account in /fixture/schemas.ts), which the tables file does not export; export it there",
		)
		expect(() => analyzeNamespace({ note })).toThrow(
			"note.accountId references the table account, which no module of the project exports",
		)
	})

	it("reads a pg schema's table with its schema, an identity and a generated column", () => {
		const auth = pgSchema("auth")
		const account = auth.table("account", {
			id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
			total: integer("total").generatedAlwaysAs(sql`1 + 1`),
		})
		const [table] = analyzeNamespace({ account }).tables
		expect(table?.schema).toBe("auth")
		expect(table?.fields.map((field) => [field.name, field.identity, field.generated, field.hasDefault])).toEqual([
			["id", true, false, true],
			["total", false, true, false],
		])
	})
})

describe("snapshotOf: machines, keys and checks read in the parent's own process", () => {
	it("reads a machine with no initial state, a CHECK as SQL, and names a key whose target cannot be followed", () => {
		const [table] = analyzeNamespace({
			t: sqliteTable("t", { n: sqliteInteger("n"), s: c.enum("s", ["a", "b"], { terminal: ["b"] }) }, (t) => [
				check("t_n_positive", sql`${t.n} > 0`),
			]),
		}).tables
		expect(table?.fields.find((field) => field.name === "s")?.states).toEqual({
			initial: null,
			terminal: ["b"],
			transitions: null,
		})
		expect(table?.checkConstraints).toEqual([{ expression: '"n" > 0', name: "t_n_positive" }])
		const [flow] = analyzeNamespace({
			f: sqliteTable("f", {
				s: c.enum("s", ["a", "b"], { transitions: { a: ["b"] } }),
				u: c.text("u").unique("f_u"),
				v: c.text("v").unique(),
			}),
		}).tables
		expect(flow?.fields.map((field) => [field.states?.transitions ?? null, field.unique])).toEqual([
			[{ a: ["b"] }, null],
			[null, "f_u"],
			[null, "f_v_unique"],
		])
		const mood = pgEnum("mood", ["ok", "sad"])
		expect(analyzeNamespace({ p: pgTable("p", { m: mood("m") }) }).tables[0]?.fields[0]?.enumValues).toEqual([
			"ok",
			"sad",
		])
		const broken = sqliteTable("broken", {
			x: c.ref("x").references(() => {
				throw new Error("not yet defined")
			}),
		})
		expect(() => analyzeNamespace({ broken })).toThrow("broken: a foreign key's target cannot be read: not yet defined")
	})
})

describe("readTables: a module only types use (F42a)", () => {
	it("loads no module the tables file imports only for its types, however it imports them", async () => {
		const tables = write({
			"bad.ts": `export type Bad = string\nthrow new Error("bad loaded")\n`,
			"db.core.tables.ts": `${HEAD}import { type Bad } from "./bad.ts"
import { Bad as Also } from "./bad.ts"
let a: Bad | Also | undefined
export const note = sqliteTable("note", { id: c.id("not") })
`,
		})
		expect((await readTables(tables)).tables.map((table) => table.exportName)).toEqual(["note"])
	})
})

/* the 0.12 review's F36: a column named __proto__, which drizzle assigns onto the table as its prototype */
describe("snapshotOf: a table a column named __proto__ broke (F36)", () => {
	it("is refused, naming the export, not left out of every generated file", () => {
		const columns = Object.defineProperty({ id: c.id("brk") }, "__proto__", { enumerable: true, value: c.text("p") })
		const broken = sqliteTable("broken", columns as never)
		expect(() => analyzeNamespace({ broken })).toThrow(
			"broken: a column named __proto__ replaced this table's prototype, so drizzle cannot use it; rename the column",
		)
		/* any other value without drizzle's table name is no table, and is passed over */
		expect(analyzeNamespace({ answer: 42, list: [] }).tables).toEqual([])
	})
})
