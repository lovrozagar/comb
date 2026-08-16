import { getTableColumns } from "drizzle-orm"
import { pgTable } from "drizzle-orm/pg-core"
import { describe, expect, it } from "vitest"
import { c } from "../../../src/pg/columns.ts"

/* Build test tables — getTableColumns gives runtime Column objects with dataType */
const entityTable = pgTable("entity", {
	active: c.boolean("active"),
	age: c.integer("age"),
	createdAt: c.createdAt("created_at"),
	data: c.json("data"),
	deletedAt: c.deletedAt("deleted_at"),
	id: c.id("usr"),
	name: c.text("name"),
	role: c.enum("role", ["admin", "user"] as const),
	score: c.real("score"),
	ts: c.timestamp("ts"),
	updatedAt: c.updatedAt("updated_at"),
	userId: c.ref("user_id"),
})

const autoTable = pgTable("auto", {
	id: c.serialId(),
})

/* Drizzle builder types don't expose dataType — use toHaveProperty for runtime checks */
const cols = getTableColumns(entityTable)
const autoCols = getTableColumns(autoTable)

describe("pg columns", () => {
	it("c.id returns text column with primaryKey", () => {
		expect(cols.id).toHaveProperty("dataType", "string")
	})

	it("c.serialId returns serial column", () => {
		expect(autoCols.id).toHaveProperty("dataType", expect.stringContaining("number"))
	})

	it("c.text returns text column", () => {
		expect(cols.name).toHaveProperty("dataType", "string")
	})

	it("c.integer returns integer column", () => {
		expect(cols.age).toHaveProperty("dataType", expect.stringContaining("number"))
	})

	it("c.boolean returns native boolean column", () => {
		expect(cols.active).toHaveProperty("dataType", "boolean")
	})

	it("c.real returns double precision column", () => {
		expect(cols.score).toHaveProperty("dataType", expect.stringContaining("number"))
	})

	it("c.ref returns text column", () => {
		expect(cols.userId).toHaveProperty("dataType", "string")
	})

	it("c.enum returns text column", () => {
		expect(cols.role).toHaveProperty("dataType", "string")
	})

	it("c.enum accepts a third-argument state machine without changing the column", () => {
		const table = pgTable("job", {
			status: c.enum("status", ["queued", "done"] as const, { terminal: ["done"] }),
		})
		expect(getTableColumns(table).status).toHaveProperty("dataType", "string")
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

	it("c.json returns jsonb column", () => {
		expect(cols.data).toHaveProperty("dataType", expect.stringContaining("json"))
	})
})
