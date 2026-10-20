import { describe, expect, it } from "vitest"
import { SQL_SORT_DIR } from "./sql.ts"

describe("SQL_SORT_DIR", () => {
	it("maps every parser direction to its SQL keyword", () => {
		expect(SQL_SORT_DIR.asc).toBe("ASC")
		expect(SQL_SORT_DIR.desc).toBe("DESC")
	})
})
