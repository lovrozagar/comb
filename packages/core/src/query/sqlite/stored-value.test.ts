import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { describe, expect, it } from "vitest"
import { asStored } from "./stored-value.ts"

const event = sqliteTable("event", {
	at: integer("at", { mode: "timestamp_ms" }),
	ms: integer("ms"),
	name: text("name"),
})

/* Q5 of the 0.14.1 review: an ISO date field's instant as the column stores it */
describe("asStored", () => {
	const at = "2024-01-01T00:00:00.000Z"

	it("binds an ISO instant as epoch milliseconds on a date or number column, one by one in a list", () => {
		expect(asStored({ field: "at", operator: "eq", value: at }, event.at).value).toBe(Date.UTC(2024, 0, 1))
		expect(asStored({ field: "ms", operator: "in", value: [at, 5] }, event.ms).value).toEqual([Date.UTC(2024, 0, 1), 5])
	})

	it("keeps it as text on a text column, and any other value as it is", () => {
		expect(asStored({ field: "name", operator: "eq", value: at }, event.name).value).toBe(at)
		expect(asStored({ field: "ms", operator: "eq", value: "2024-01-01" }, event.ms).value).toBe("2024-01-01")
	})
})
