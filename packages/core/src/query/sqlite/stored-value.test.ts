import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { describe, expect, it } from "vitest"
import { IsoInstant } from "../iso-date.ts"
import { asStored } from "./stored-value.ts"

const event = sqliteTable("event", {
	at: integer("at", { mode: "timestamp_ms" }),
	ms: integer("ms"),
	name: text("name"),
})

/* Q5 of the 0.14.1 review: an ISO date field's instant as the column stores it */
describe("asStored", () => {
	const at = new IsoInstant(Date.UTC(2024, 0, 1))

	it("binds an ISO instant as epoch milliseconds on a date or number column, one by one in a list", () => {
		expect(asStored({ field: "at", operator: "eq", value: at }, event.at).value).toBe(Date.UTC(2024, 0, 1))
		expect(asStored({ field: "ms", operator: "in", value: [at, 5] }, event.ms).value).toEqual([Date.UTC(2024, 0, 1), 5])
	})

	it("binds it as its text on a text column, and any other value as it is, ISO-looking text included", () => {
		expect(asStored({ field: "name", operator: "eq", value: at }, event.name).value).toBe("2024-01-01T00:00:00.000Z")
		const spelled = "2024-01-01T00:00:00.000Z"
		expect(asStored({ field: "ms", operator: "eq", value: spelled }, event.ms).value).toBe(spelled)
	})
})
