import { describe, expect, it } from "vitest"
import { notEngineTables } from "./engine-tables.ts"

describe("notEngineTables", () => {
	it("leaves out SQLite's own tables, and D1's when the connection owns the prefix", () => {
		expect(notEngineTables({})).toBe(" AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'")
		expect(notEngineTables({ ownedPrefix: "_cf_" })).toBe(
			" AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'",
		)
	})

	it("escapes a prefix's quotes, backslashes and wildcards", () => {
		expect(notEngineTables({ ownedPrefix: "a'%\\" })).toContain("NOT LIKE 'a''\\%\\\\%'")
	})
})
