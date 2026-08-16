import { describe, expect, it } from "vitest"
import { CombError } from "../../../src/error.ts"

describe("CombError", () => {
	it("sets status from statusKey", () => {
		const err = new CombError({
			errorKey: "unique_constraint_violation",
			status: "conflict",
		})
		expect(err.status).toBe(409)
		expect(err.statusKey).toBe("conflict")
		expect(err.errorKey).toBe("unique_constraint_violation")
		expect(err.message).toBe("unique_constraint_violation")
	})

	it("stores table and column metadata", () => {
		const err = new CombError({
			column: "email",
			errorKey: "unique_constraint_violation",
			status: "conflict",
			table: "user",
		})
		expect(err.table).toBe("user")
		expect(err.column).toBe("email")
	})

	it("preserves cause", () => {
		const cause = new Error("original")
		const err = new CombError({
			cause,
			errorKey: "database_io_error",
			status: "internal_server_error",
		})
		expect(err.cause).toBe(cause)
	})

	it("omits cause option when undefined", () => {
		const err = new CombError({
			errorKey: "database_io_error",
			status: "internal_server_error",
		})
		expect(err.cause).toBeUndefined()
	})

	it("is an instance of Error", () => {
		const err = new CombError({
			errorKey: "database_unavailable",
			status: "service_unavailable",
		})
		expect(err).toBeInstanceOf(Error)
		expect(err).toBeInstanceOf(CombError)
	})

	it("maps all status keys correctly", () => {
		const cases: Array<[string, number]> = [
			["bad_request", 400],
			["conflict", 409],
			["internal_server_error", 500],
			["service_unavailable", 503],
			["unprocessable_entity", 422],
		]
		for (const [key, code] of cases) {
			const err = new CombError({
				errorKey: "test",
				status: key as "bad_request",
			})
			expect(err.status).toBe(code)
		}
	})
})
