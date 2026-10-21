import { describe, expect, it } from "vitest"
import { valueError } from "./value-error.ts"

describe("valueError", () => {
	it.each(["22001", "22003", "22021", "22P02", "SQLITE_CONSTRAINT_DATATYPE", "SQLITE_MISMATCH"])(
		"answers %s with a 400 invalid_value that names the column, never the value",
		(code) => {
			const source = new Error("raw")
			expect(valueError(code, { column: "n", table: "t" }, source)).toMatchObject({
				cause: "Invalid value for n",
				column: "n",
				errorKey: "invalid_value",
				source,
				status: 400,
				table: "t",
			})
		},
	)

	it.each(["54000", "SQLITE_TOOBIG"])("answers %s with a 400 value_too_large, the same on every dialect", (code) => {
		expect(valueError(code, {}, null)).toMatchObject({ cause: "Value too large", errorKey: "value_too_large" })
	})

	it("is undefined for a code that is no value error, an inherited name included", () => {
		expect(valueError("22012", {}, null)).toBeUndefined()
		expect(valueError("constructor", {}, null)).toBeUndefined()
	})
})
