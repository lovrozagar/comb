import { pgSchema, pgTable, text } from "drizzle-orm/pg-core"
import { describe, expect, it } from "vitest"
import { analyzeNamespace } from "../__fixtures__/runtime.ts"
import { errorKeyPrefix, qualifiedName, tableIdentifier } from "./table-name.ts"
import { validateTables } from "./validate.ts"

/** A table of only a text key */
const id = () => ({ id: text("id").primaryKey() })

describe("a table's names where a Postgres schema is set (F51)", () => {
	it("qualifies a schema'd table, joins its error keys with an underscore, and quotes each SQL part", () => {
		expect(qualifiedName({ schema: "auth", sqlName: "users" })).toBe("auth.users")
		expect(qualifiedName({ schema: null, sqlName: "users" })).toBe("users")
		expect(errorKeyPrefix({ schema: "auth", sqlName: "users" })).toBe("auth_users")
		expect(errorKeyPrefix({ schema: null, sqlName: "users" })).toBe("users")
		expect(tableIdentifier({ schema: "auth", sqlName: "users" })).toBe('"auth"."users"')
		expect(tableIdentifier({ schema: null, sqlName: "users" })).toBe('"users"')
	})

	it("lets two schemas share a table name, and refuses one schema naming it twice", () => {
		const auth = pgSchema("auth")
		const apart = analyzeNamespace({ authUsers: auth.table("users", id()), users: pgTable("users", id()) })
		expect(validateTables(apart).errors).toEqual([])
		const twice = analyzeNamespace({ authUsers: auth.table("users", id()), members: auth.table("users", id()) })
		expect(validateTables(twice).errors).toContain('Duplicate SQL table name: "auth.users" (var: members)')
	})
})
