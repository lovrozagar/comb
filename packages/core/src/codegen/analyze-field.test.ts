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
	})

	it("reads the JSON schema a c.json column names", () => {
		expect(parseField("settings", 'c.json("settings", settingsSchema)').jsonSchemaName).toBe("settingsSchema")
		expect(parseField("settings", 'c.text("settings")').jsonSchemaName).toBeNull()
	})
})
