import { describe, expect, it } from "vitest"
import type { CombError } from "../../../../src/error.ts"
import { d1ErrorHandler } from "../../../../src/sqlite/d1/error-handler.ts"

describe("d1ErrorHandler", () => {
	it("ignores non-Error objects", () => {
		expect(() => d1ErrorHandler("not an error", [])).not.toThrow()
		expect(() => d1ErrorHandler(null, [])).not.toThrow()
		expect(() => d1ErrorHandler(42, [])).not.toThrow()
	})

	it("throws service_unavailable for transient D1 errors", () => {
		const patterns = [
			"D1_ERROR: network connection lost",
			"D1_ERROR: overloaded",
			"D1_ERROR: too many requests",
			"D1_ERROR: memory limit exceeded",
			"D1_ERROR: cpu time limit reached",
		]
		for (const msg of patterns) {
			try {
				d1ErrorHandler(new Error(msg), [])
				expect.unreachable(`should throw for: ${msg}`)
			} catch (e) {
				const err = e as CombError
				expect(err.statusKey).toBe("service_unavailable")
				expect(err.errorKey).toBe("database_unavailable")
			}
		}
	})

	it("throws unprocessable_entity for storage limit errors", () => {
		try {
			d1ErrorHandler(new Error("D1_ERROR: size limit exceeded"), [])
			expect.unreachable("should throw")
		} catch (e) {
			const err = e as CombError
			expect(err.statusKey).toBe("unprocessable_entity")
			expect(err.errorKey).toBe("tier_database_limit_reached")
		}
	})

	it("throws internal_server_error for other D1_ERROR", () => {
		try {
			d1ErrorHandler(new Error("D1_ERROR: unknown failure"), [])
			expect.unreachable("should throw")
		} catch (e) {
			const err = e as CombError
			expect(err.statusKey).toBe("internal_server_error")
			expect(err.errorKey).toBe("database_io_error")
		}
	})

	it("throws internal_server_error for execution errors", () => {
		const codes = ["D1_EXEC_ERROR", "D1_TYPE_ERROR", "D1_COLUMN_NOTFOUND"]
		for (const code of codes) {
			try {
				d1ErrorHandler(new Error(`${code}: bad query`), [])
				expect.unreachable(`should throw for: ${code}`)
			} catch (e) {
				const err = e as CombError
				expect(err.statusKey).toBe("internal_server_error")
				expect(err.errorKey).toBe("database_io_error")
			}
		}
	})

	it("delegates constraint violations to constraint handler", () => {
		try {
			d1ErrorHandler(new Error("UNIQUE constraint failed: user.email"), [])
			expect.unreachable("should throw")
		} catch (e) {
			const err = e as CombError
			expect(err.errorKey).toBe("unique_constraint_violation")
			expect(err.table).toBe("user")
			expect(err.column).toBe("email")
		}
	})

	it("passes through non-matching errors", () => {
		expect(() => d1ErrorHandler(new Error("something else entirely"), [])).not.toThrow()
	})
})
