import { describe, expect, it } from "vitest"
import { valueError } from "./value-error.ts"

describe("valueError", () => {
	it.each(["22001", "22003", "22009", "22021", "22P02", "SQLITE_CONSTRAINT_DATATYPE", "SQLITE_MISMATCH"])(
		"answers %s with a 400 invalid_value that names the column, never the value",
		(code) => {
			const source = new Error("raw")
			expect(valueError({ code }, { column: "n", table: "t" }, source)).toMatchObject({
				cause: "Invalid value for n",
				column: "n",
				errorKey: "invalid_value",
				source,
				status: 400,
				table: "t",
			})
		},
	)

	it.each([
		["54000", undefined],
		["SQLITE_TOOBIG", "string or blob too big"],
	])("answers %s with a 400 value_too_large, the same on every dialect", (code, message) => {
		expect(valueError({ code, message }, {}, null)).toMatchObject({
			cause: "Value too large",
			errorKey: "value_too_large",
		})
	})

	/* C6 of the 0.14.1 review: the engine's code for a statement past its length limit too, which the server built */
	it("is undefined for SQLITE_TOOBIG on a statement too long, or with no message", () => {
		expect(valueError({ code: "SQLITE_TOOBIG", message: "statement too long" }, {}, null)).toBeUndefined()
		expect(valueError({ code: "SQLITE_TOOBIG" }, {}, null)).toBeUndefined()
	})

	it("is undefined for a code that is no value error, an inherited name included", () => {
		expect(valueError({ code: "22012" }, {}, null)).toBeUndefined()
		expect(valueError({ code: "constructor" }, {}, null)).toBeUndefined()
	})
})
