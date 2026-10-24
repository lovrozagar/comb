import { fixtureRoot } from "../__fixtures__/temp.ts"
import fs from "node:fs"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { analyze } from "../analyzer.ts"
import { generateDiagrams } from "./diagrams.ts"
import { testContext } from "./__fixtures__/context.ts"

const PRELUDE = `
import { sqliteTable as createTable, text, integer, real, blob } from "drizzle-orm/sqlite-core"
import { c } from "@lovrozagar/comb/sqlite/columns"
`

type Generated = { ddl: string; json: { relationCount: number; tableCount: number }; logged: string[]; summary: string }

let tmpDir: string

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(fixtureRoot(), "comb-gen-diagrams-"))
})

afterEach(() => {
	fs.rmSync(tmpDir, { force: true, recursive: true })
})

function generate(body: string): Generated {
	const fp = path.join(tmpDir, "db.test.tables.ts")
	fs.writeFileSync(fp, `${PRELUDE}${body}\n`)
	const ctx = testContext(analyze(fp), { cwd: tmpDir })
	generateDiagrams(ctx, { output: "diagrams" })
	const read = (name: string) => fs.readFileSync(path.join(tmpDir, "diagrams", name), "utf-8")
	return {
		ddl: read("test-schema.gen.sql"),
		json: JSON.parse(read("test-relations.gen.json")) as Generated["json"],
		logged: ctx.logged,
		summary: read("test-ai.gen.txt"),
	}
}

describe("generateDiagrams", () => {
	it("writes DDL, relations JSON and an AI summary named by the database", () => {
		const { ddl, json, logged, summary } = generate(`
export const user = createTable("user", { id: c.id(), name: c.text("name").notNull(), age: c.integer("age") })
export const post = createTable("post", {
	id: c.id(),
	title: c.text("title").notNull(),
	author_id: c.ref("author_id").references(() => user.id, { onDelete: "cascade" }).notNull(),
})
`)
		/* every identifier quoted, so a keyword such as order or group stays a name (F10) */
		expect(ddl).toContain('CREATE TABLE "user"')
		expect(ddl).toContain('CREATE TABLE "post"')
		expect(ddl).toContain('"name" TEXT NOT NULL')
		expect(ddl).toContain('REFERENCES "user"("id") ON DELETE CASCADE')
		expect(json).toMatchObject({ relationCount: 1, tableCount: 2 })
		expect(summary).toContain("# 2 tables, 1 FKs")
		expect(logged).toEqual(["Generated diagrams: 2 tables, 1 relations"])
	})

	it("maps each drizzle helper onto its SQL type", () => {
		const { ddl } = generate(`
export const mixed = createTable("mixed", {
	id: c.id(),
	name: c.text("name"),
	count: c.integer("count"),
	active: c.boolean("active"),
	score: c.real("score"),
	data: blob("data"),
})
`)
		for (const def of [
			'"id" TEXT PRIMARY KEY',
			'"name" TEXT',
			'"count" INTEGER',
			'"active" INTEGER',
			'"score" REAL',
			'"data" BLOB',
		]) {
			expect(ddl).toContain(def)
		}
	})

	it("renders ON UPDATE alongside ON DELETE", () => {
		const { ddl } = generate(`
export const author = createTable("author", { id: c.id() })
export const post = createTable("post", {
	id: c.id(),
	author_id: c.ref("author_id").references(() => author.id, { onDelete: "set null", onUpdate: "cascade" }),
})
`)
		expect(ddl).toContain("ON DELETE SET NULL")
		expect(ddl).toContain("ON UPDATE CASCADE")
	})
})

describe("generateDiagrams — edge shapes", () => {
	it("leaves out a table with no columns and prints a reference with no rules bare", () => {
		const { ddl, json } = generate(`
export const author = createTable("author", { id: c.id() })
export const nothing = createTable("nothing", {})
export const post = createTable("post", { id: c.id(), author_id: c.ref("author_id").references(() => author.id) })
`)
		expect(json.tableCount).toBe(2)
		expect(ddl).not.toContain("nothing")
		expect(ddl).toContain('"author_id" TEXT REFERENCES "author"("id")\n')
	})

	it("writes into an output directory that already exists", () => {
		fs.mkdirSync(path.join(tmpDir, "diagrams"))
		expect(generate(`export const ping = createTable("ping", { id: c.id() })`).json.tableCount).toBe(1)
	})
})

describe("generateDiagrams — the compact summary", () => {
	it("lists a table's own columns, or says it carries only common ones", () => {
		const { summary } = generate(`
export const post = createTable("post", { id: c.id(), title: c.text("title"), created_at: c.integer("created_at") })
export const ping = createTable("ping", { id: c.id() })
`)
		expect(summary).toContain("## Tables & Columns\n1. ping: (only common cols)\n2. post: title\n")
	})

	it("numbers references by table, marks delete rules, and puts the most referenced target first", () => {
		const { summary } = generate(`
export const hot = createTable("hot", { id: c.id() })
export const cold = createTable("cold", { id: c.id() })
export const a = createTable("a", { id: c.id(), x: c.ref("x").references(() => hot.id, { onDelete: "cascade" }) })
export const b = createTable("b", { id: c.id(), y: c.ref("y").references(() => hot.id, { onDelete: "restrict" }) })
export const e = createTable("e", {
	id: c.id(),
	z: c.ref("z").references(() => cold.id, { onDelete: "set null" }),
})
`)
		expect(summary.slice(summary.indexOf("## FK refs"))).toBe(
			"## FK refs (target <- source.col)\n5 <- 1.x[c], 2.y[r]\n3 <- 4.z[n]\n",
		)
	})
})

describe("generateDiagrams on a Postgres database (F36)", () => {
	it("writes Postgres DDL, each table after the tables it references, which Postgres takes as it is", () => {
		const fp = path.join(tmpDir, "db.test.tables.ts")
		fs.writeFileSync(
			fp,
			`import { pgTable } from "drizzle-orm/pg-core"
import { c } from "@lovrozagar/comb/pg/columns"
import * as z from "zod"
export const meta = z.object({ a: z.string() })
export const alpha = pgTable("alpha", { id: c.id("al"), teamId: c.ref("team_id").references(() => zteam.id), at: c.timestamp("at"), ok: c.boolean("ok"), blob: c.json("blob", meta), ratio: c.real("ratio") })
export const zteam = pgTable("zteam", { id: c.id("tm"), parentId: c.ref("parent_id").references((): any => zteam.id) })
`,
		)
		const ctx = { ...testContext(analyze(fp), { cwd: tmpDir }), dialect: "postgres" as const }
		generateDiagrams(ctx, { output: "diagrams" })
		const ddl = fs.readFileSync(path.join(tmpDir, "diagrams", "test-schema.gen.sql"), "utf-8")
		expect(ddl).toContain("-- test Database Schema (Postgres)")
		expect(ddl.indexOf('CREATE TABLE "zteam"')).toBeLessThan(ddl.indexOf('CREATE TABLE "alpha"'))
		for (const type of ['"at" BIGINT', '"ok" BOOLEAN', '"blob" JSONB', '"ratio" DOUBLE PRECISION', '"team_id" TEXT'])
			expect(ddl).toContain(type)
	})
})

describe("generateDiagrams: a reference cycle", () => {
	it("writes every table of a cycle, which no order satisfies, in name order", () => {
		const { ddl } =
			generate(`export const a = createTable("a", { id: text("id").primaryKey(), b_id: text("b_id").references((): any => b.id) })
export const b = createTable("b", { id: text("id").primaryKey(), a_id: text("a_id").references((): any => a.id) })`)
		expect(ddl.indexOf('CREATE TABLE "a"')).toBeLessThan(ddl.indexOf('CREATE TABLE "b"'))
		expect(ddl).toContain('"b_id" TEXT REFERENCES "b"("id")')
	})
})
