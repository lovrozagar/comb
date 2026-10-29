import { describe, expect, it } from "vitest"
import { isoInstant } from "./iso-date.ts"

/* Q5 of the 0.14.1 review; the field-level cases are filter-validate.fields.test.ts's */
describe("isoInstant", () => {
	it("reads every spelling of one instant as one, a bare date as midnight UTC", () => {
		for (const raw of ["2024-01-01", "2024-01-01T00:00Z", "2024-01-01T01:30+01:30", "2023-12-31T19:00:00.000-05:00"])
			expect(String(isoInstant(raw)), raw).toBe("2024-01-01T00:00:00.000Z")
	})

	it("names no instant for a day the calendar has not, or text no ISO 8601 date", () => {
		for (const raw of ["2023-02-29", "2024-01-01T23:59:60Z", "2024-01-01T00:00+24:00", "yesterday"])
			expect(isoInstant(raw), raw).toBeUndefined()
	})
})
