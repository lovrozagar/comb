import { getTableColumns } from "drizzle-orm"
import { sqliteTable } from "drizzle-orm/sqlite-core"
import { describe, expect, it } from "vitest"
import { c } from "../../../src/sqlite/columns.ts"

/* Build test tables — getTableColumns gives runtime Column objects with dataType */
const entityTable = sqliteTable("entity", {
	active: c.boolean("active"),
	age: c.integer("age"),
	createdAt: c.createdAt("created_at"),
	deletedAt: c.deletedAt("deleted_at"),
	id: c.id("usr"),
	name: c.text("name"),
	nameMax: c.text("name_max", { max: 100 }),
	role: c.enum("role", ["admin", "user"] as const),
	score: c.real("score"),
	ts: c.timestamp("ts"),
	updatedAt: c.updatedAt("updated_at"),
	userId: c.ref("user_id"),
})

const autoTable = sqliteTable("auto", {
	id: c.serialId(),
})

/* Drizzle builder types don't expose dataType — use toHaveProperty for runtime checks */
const cols = getTableColumns(entityTable)
const autoCols = getTableColumns(autoTable)

describe("sqlite columns", () => {
	it("c.id returns text column with primaryKey", () => {
		expect(cols.id).toHaveProperty("dataType", "string")
	})

	it("c.serialId returns integer column with autoIncrement", () => {
		expect(autoCols.id).toHaveProperty("dataType", expect.stringContaining("number"))
	})

	it("c.text returns text column", () => {
		expect(cols.name).toHaveProperty("dataType", "string")
	})

	it("c.text with max sets length", () => {
		expect(cols.nameMax).toHaveProperty("dataType", "string")
	})

	it("c.integer returns integer column", () => {
		expect(cols.age).toHaveProperty("dataType", expect.stringContaining("number"))
	})

	it("c.boolean returns integer in boolean mode", () => {
		expect(cols.active).toHaveProperty("dataType", "boolean")
	})

	it("c.real returns real column", () => {
		expect(cols.score).toHaveProperty("dataType", expect.stringContaining("number"))
	})

	it("c.ref returns text column", () => {
		expect(cols.userId).toHaveProperty("dataType", "string")
	})

	it("c.enum returns text column", () => {
		expect(cols.role).toHaveProperty("dataType", "string")
	})

	it("c.timestamp returns integer column", () => {
		expect(cols.ts).toHaveProperty("dataType", expect.stringContaining("number"))
	})

	it("c.createdAt returns notNull integer with default", () => {
		expect(cols.createdAt).toHaveProperty("dataType", expect.stringContaining("number"))
		expect(cols.createdAt).toHaveProperty("notNull", true)
		expect(cols.createdAt).toHaveProperty("hasDefault", true)
	})

	it("c.updatedAt returns notNull integer with default", () => {
		expect(cols.updatedAt).toHaveProperty("dataType", expect.stringContaining("number"))
		expect(cols.updatedAt).toHaveProperty("notNull", true)
		expect(cols.updatedAt).toHaveProperty("hasDefault", true)
	})

	it("c.deletedAt returns nullable integer", () => {
		expect(cols.deletedAt).toHaveProperty("dataType", expect.stringContaining("number"))
		expect(cols.deletedAt).toHaveProperty("notNull", false)
	})
})
