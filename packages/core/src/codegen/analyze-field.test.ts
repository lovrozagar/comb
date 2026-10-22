import { describe, expect, it } from "vitest"
import { parseField } from "./analyze-field.ts"

describe("parseField", () => {
	it("reads the helper, SQL name and nullability", () => {
		expect(parseField("displayName", 'c.text("display_name").notNull()')).toMatchObject({
			drizzleHelper: "text",
			isNotNull: true,
			isPrimaryKey: false,
			name: "displayName",
			sqlName: "display_name",
		})
		expect(parseField("total", "integer('total_cents', { mode: \"number\" })")).toMatchObject({
			drizzleHelper: "unknown",
			sqlName: "total_cents",
		})
		expect(parseField("raw", "someColumn()")).toMatchObject({ sqlName: "raw" })
	})

	it("treats c.id and c.serialId as the id primary key", () => {
		expect(parseField("id", 'c.id("usr")')).toMatchObject({ isNotNull: true, isPrimaryKey: true, sqlName: "id" })
		expect(parseField("id", "c.serialId()")).toMatchObject({ isPrimaryKey: true, sqlName: "id" })
		expect(parseField("id", 'text("id").primaryKey()')).toMatchObject({ isPrimaryKey: true })
	})

	it("reads a reference and its actions, from .references or the c.ref helper", () => {
		expect(
			parseField("org_id", 'c.ref("org_id").references(() => org.id, { onDelete: "set null", onUpdate: "cascade" })')
				.foreignKey,
		).toEqual({ column: "org_id", onDelete: "set null", onUpdate: "cascade", refColumn: "id", refTable: "org" })
		expect(
			parseField("owner", 'c.ref<Owner>("owner_id", { max: 30 }).references(() => owner.code)').foreignKey,
		).toMatchObject({
			refColumn: "code",
			refTable: "owner",
		})
		expect(parseField("x", 'c.text("x")').foreignKey).toBeNull()
		expect(parseField("org_id", 'c.ref("org_id")').foreignKey).toBeNull()
		/* options held in a variable: the target is still read, the actions are not visible */
		expect(parseField("org_id", 'text("org_id").references(() => org.id, refOptions)').foreignKey).toEqual({
			column: "org_id",
			onDelete: undefined,
			onUpdate: undefined,
			refColumn: "id",
			refTable: "org",
		})
	})
})

describe("parseField: self-references (M-M3)", () => {
	it("reads a reference whose arrow carries a return type, as drizzle requires for a self-reference", () => {
		const raw = 'text("parent_id").references((): AnySQLiteColumn => folder.id, { onDelete: "cascade" })'
		expect(parseField("parent_id", raw).foreignKey).toEqual({
			column: "parent_id",
			onDelete: "cascade",
			onUpdate: undefined,
			refColumn: "id",
			refTable: "folder",
		})
		expect(parseField("p", 'c.ref("p").references((): AnyPgColumn => folder.id)').foreignKey).toMatchObject({
			refColumn: "id",
			refTable: "folder",
		})
	})
})

describe("parseField: nullability the helpers declare (M-M9)", () => {
	it("knows c.createdAt and c.updatedAt are not null and c.deletedAt is", () => {
		expect(parseField("created_at", 'c.createdAt("created_at")').isNotNull).toBe(true)
		expect(parseField("updatedAt", 'c.updatedAt("updatedAt")').isNotNull).toBe(true)
		expect(parseField("deleted_at", 'c.deletedAt("deleted_at")').isNotNull).toBe(false)
	})
})

describe("parseField: a text column's length", () => {
	it("is its max, else drizzle's own positional length or length option, else none", () => {
		expect(parseField("n", 'c.text("name", { max: 100 })').length).toBe(100)
		expect(parseField("n", 'c.text("name", 50)').length).toBe(50)
		expect(parseField("n", 'text("n", { length: 40 })').length).toBe(40)
		expect(parseField("n", 'c.text("name")').length).toBeNull()
	})
})
