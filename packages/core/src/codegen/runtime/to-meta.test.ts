import { sql } from "drizzle-orm"
import { pgTable } from "drizzle-orm/pg-core"
import { integer, primaryKey, sqliteTable, text, unique, uniqueIndex } from "drizzle-orm/sqlite-core"
import { describe, expect, it } from "vitest"
import * as z from "zod"
import { c } from "../../sqlite/columns.ts"
import { analyzeNamespace } from "../__fixtures__/runtime.ts"
import { toAnalysis } from "./to-meta.ts"

/** The timestamps of one table `t` of `columns` */
const meta = (columns: Record<string, unknown>) =>
	analyzeNamespace({ t: sqliteTable("t", columns as never) }).tables[0]?.timestamps

describe("toAnalysis", () => {
	it("refuses a database holding tables of both engines, and is no dialect when it holds none", () => {
		const both = { a: sqliteTable("a", { id: text("id") }), b: pgTable("b", {}) }
		expect(() => analyzeNamespace(both)).toThrow("the database holds both Postgres and SQLite tables")
		expect(toAnalysis({ tables: [] }, "/x/db.core.tables.ts")).toMatchObject({
			dbName: "core",
			dialect: null,
			tables: [],
		})
	})

	it("sorts plain, partial and expression unique indexes apart, and keeps the composite key", () => {
		const [table] = analyzeNamespace({
			t: sqliteTable("t", { a: text("a"), b: text("b"), email: text("email") }, (t) => [
				primaryKey({ columns: [t.a, t.b] }),
				unique("t_ab").on(t.a, t.b),
				uniqueIndex("t_a_live")
					.on(t.a)
					.where(sql`${t.b} is null`),
				uniqueIndex("t_email_lower").on(sql`lower(${t.email})`),
				uniqueIndex("t_b").on(t.b),
			]),
		}).tables
		expect(table).toMatchObject({
			expressionIndexes: [{ expression: 'lower("email")', name: "t_email_lower" }],
			hasCompositePrimaryKey: true,
			partialUniqueIndexes: [{ columns: ["a"], name: "t_a_live" }],
			uniqueIndexes: [
				{ columns: ["a", "b"], name: "t_ab" },
				{ columns: ["b"], name: "t_b" },
			],
		})
		expect(table?.fields.map((field) => field.inCompositeKey)).toEqual([true, true, false])
	})
})

describe("toAnalysis: timestamps and what fills them", () => {
	it("detects timestamps by name on epoch columns only, and their casing", () => {
		/* a plain integer is named, but no spread holds it: its read schema is its own (F10) */
		expect(meta({ createdAt: c.createdAt("created_at"), updated_at: integer("updated_at") })).toMatchObject({
			createdAt: true,
			names: { createdAt: "createdAt", deletedAt: null, updatedAt: "updated_at" },
			style: "mixed",
			updatedAt: false,
		})
		expect(meta({ created_at: c.createdAt("created_at") })?.style).toBe("snake_case")
		expect(meta({ createdAt: text("created_at") })).toMatchObject({ createdAt: false, style: "camelCase" })
		expect(meta({ createdAt: c.real("created_at") })?.createdAt).toBe(false)
	})

	it("fills autogenerate for a timestamp a default or an update hook fills, by its name", () => {
		const fields = analyzeNamespace({
			t: sqliteTable("t", {
				created_at: integer("created_at").default(sql`0`),
				other: integer("other").default(0),
				updated_at: integer("updated_at").$onUpdate(() => 1),
			}),
		}).tables[0]?.fields
		expect(fields?.map((field) => [field.name, field.constraints.autogenerate])).toEqual([
			["created_at", true],
			["other", false],
			["updated_at", true],
		])
	})
})

describe("toAnalysis: references and schemas", () => {
	it("refuses mutable on a column that references nothing", () => {
		expect(() => analyzeNamespace({ t: sqliteTable("t", { n: c.text("n", { mutable: true }) }) })).toThrow(
			"/fixture/db.core.tables.ts: t.n: mutable lets a reference move on update, and n references nothing",
		)
		expect(
			analyzeNamespace({ t: sqliteTable("t", { n: c.ref("n", { mutable: true }) }) }).tables[0]?.fields[0]?.constraints
				.mutable,
		).toBe(true)
	})

	it("imports a schema a package exports by its specifier, and a project file's by its path", () => {
		const prefs = z.object({})
		const own = analyzeNamespace({ prefs, t: sqliteTable("t", { p: c.json("p", prefs) }) }).tables[0]?.fields[0]
		expect(own?.schemaImports).toEqual([
			{ from: "./db.core.tables", imported: "prefs", name: "prefs", path: "/fixture/db.core.tables.ts" },
		])
		expect(own?.jsonSchemaName).toBe("prefs")
	})

	it("marks a reference to a c.id key, and reads drizzle's own length for a plain column", () => {
		const user = sqliteTable("user", { id: c.id("usr"), handle: text("handle", { length: 20 }) })
		const fields = analyzeNamespace({
			t: sqliteTable("t", {
				owner: c.ref("owner").references(() => user.id),
				handle: text("h", { length: 20 }).references(() => user.handle),
			}),
			user,
		}).tables.find((table) => table.varName === "t")?.fields
		expect(fields?.map((field) => [field.name, field.foreignKey?.toId, field.length])).toEqual([
			["owner", true, null],
			["handle", false, 20],
		])
	})
})

describe("toAnalysis: a schema a package exports", () => {
	it("imports it by the specifier the project wrote, with no path", () => {
		const column = {
			autoIncrement: false,
			comb: {
				constraints: {},
				kind: "json",
				prefix: null,
				schema: { external: true, module: "@app/schemas", name: "prefs" },
				states: null,
				values: null,
			},
			columnType: "SQLiteTextJson",
			dataType: "object json",
			dimensions: 0,
			enumValues: null,
			foreignKey: null,
			generated: false,
			hasDefault: false,
			identity: false,
			key: "prefs",
			length: null,
			notNull: false,
			onUpdate: false,
			primary: false,
			sqlName: "prefs",
			sqlType: "text",
			unique: null,
		}
		const table = {
			checks: [],
			columns: [column],
			compositeKey: [],
			dialect: "sqlite" as const,
			exportName: "t",
			indexes: [],
			schema: null,
			sqlName: "t",
			uniques: [],
		}
		expect(toAnalysis({ tables: [table] }, "/x/db.core.tables.ts").tables[0]?.fields[0]?.schemaImports).toEqual([
			{ from: "@app/schemas", imported: "prefs", name: "prefs", path: null },
		])
	})
})
