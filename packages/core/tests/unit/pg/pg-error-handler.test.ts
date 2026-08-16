import { describe, expect, it } from "vitest"
import type { CombError } from "../../../src/error.ts"
import { pgErrorHandler } from "../../../src/pg/error-handler.ts"
import type { ConstraintMap } from "../../../src/types.ts"

function pgError(code: string, extra: Record<string, string> = {}): unknown {
	return { code, message: "test error", ...extra }
}

describe("pgErrorHandler", () => {
	it("ignores non-PG errors", () => {
		expect(() => pgErrorHandler(new Error("not pg"), [])).not.toThrow()
		expect(() => pgErrorHandler(null, [])).not.toThrow()
		expect(() => pgErrorHandler({ noCode: true }, [])).not.toThrow()
	})

	describe("storage errors", () => {
		it("throws unprocessable_entity for disk full (53100)", () => {
			try {
				pgErrorHandler(pgError("53100"), [])
				expect.unreachable("should throw")
			} catch (e) {
				const err = e as CombError
				expect(err.statusKey).toBe("unprocessable_entity")
				expect(err.errorKey).toBe("tier_database_limit_reached")
			}
		})

		it("throws internal_server_error for insufficient resources (53000)", () => {
			try {
				pgErrorHandler(pgError("53000"), [])
				expect.unreachable("should throw")
			} catch (e) {
				const err = e as CombError
				expect(err.statusKey).toBe("internal_server_error")
				expect(err.errorKey).toBe("database_io_error")
			}
		})

		it("throws service_unavailable for connection failure (08006)", () => {
			try {
				pgErrorHandler(pgError("08006"), [])
				expect.unreachable("should throw")
			} catch (e) {
				const err = e as CombError
				expect(err.statusKey).toBe("service_unavailable")
				expect(err.errorKey).toBe("database_unavailable")
			}
		})

		it("throws service_unavailable for admin shutdown (57P01)", () => {
			try {
				pgErrorHandler(pgError("57P01"), [])
				expect.unreachable("should throw")
			} catch (e) {
				const err = e as CombError
				expect(err.statusKey).toBe("service_unavailable")
				expect(err.errorKey).toBe("database_readonly")
			}
		})
	})

	describe("constraint violations", () => {
		const constraintMap: ConstraintMap = {
			user: {
				unique: {
					email: {
						cause: "Email taken",
						errorKey: "user_email_unique",
						statusKey: "conflict",
					},
				},
			},
		}

		it("throws mapped unique violation with column from detail", () => {
			try {
				pgErrorHandler(
					pgError("23505", {
						detail: "Key (email)=(foo@bar.com) already exists.",
						table: "user",
					}),
					[constraintMap],
				)
				expect.unreachable("should throw")
			} catch (e) {
				const err = e as CombError
				expect(err.errorKey).toBe("user_email_unique")
				expect(err.table).toBe("user")
				expect(err.column).toBe("email")
			}
		})

		it("throws mapped unique violation via constraint name fallback", () => {
			const map: ConstraintMap = {
				user: {
					unique: {
						user_email_idx: {
							cause: "Email taken",
							errorKey: "user_email_idx_unique",
						},
					},
				},
			}
			try {
				pgErrorHandler(pgError("23505", { constraint: "user_email_idx", table: "user" }), [map])
				expect.unreachable("should throw")
			} catch (e) {
				const err = e as CombError
				expect(err.errorKey).toBe("user_email_idx_unique")
			}
		})

		it("throws fallback for unmapped unique violation", () => {
			try {
				pgErrorHandler(
					pgError("23505", {
						detail: "Key (slug)=(dup) already exists.",
						table: "post",
					}),
					[],
				)
				expect.unreachable("should throw")
			} catch (e) {
				const err = e as CombError
				expect(err.errorKey).toBe("unique_constraint_violation")
				expect(err.status).toBe(409)
				expect(err.table).toBe("post")
				expect(err.column).toBe("slug")
			}
		})

		it("throws fallback for foreign key violation", () => {
			try {
				pgErrorHandler(pgError("23503"), [])
				expect.unreachable("should throw")
			} catch (e) {
				const err = e as CombError
				expect(err.errorKey).toBe("foreign_key_violation")
				expect(err.status).toBe(409)
			}
		})

		it("throws fallback for primary key violation", () => {
			try {
				pgErrorHandler(pgError("23000"), [])
				expect.unreachable("should throw")
			} catch (e) {
				const err = e as CombError
				expect(err.errorKey).toBe("primary_key_violation")
			}
		})

		it("throws fallback for not null violation", () => {
			try {
				pgErrorHandler(pgError("23502", { detail: "Key (name)=(null)", table: "user" }), [])
				expect.unreachable("should throw")
			} catch (e) {
				const err = e as CombError
				expect(err.errorKey).toBe("required_field_missing")
				expect(err.status).toBe(400)
			}
		})

		it("throws fallback for check violation", () => {
			try {
				pgErrorHandler(pgError("23514"), [])
				expect.unreachable("should throw")
			} catch (e) {
				const err = e as CombError
				expect(err.errorKey).toBe("check_constraint_violation")
				expect(err.status).toBe(400)
			}
		})
	})

	it("passes through unknown PG error codes", () => {
		expect(() => pgErrorHandler(pgError("99999"), [])).not.toThrow()
	})
})

describe("pgErrorHandler — remaining constraint classes", () => {
	const map: ConstraintMap = {
		post: {
			check: {
				post_status_check: { cause: "status", errorKey: "post_status_invalid", statusKey: "bad_request" },
			},
			foreignKey: {
				author_id: { cause: "author", errorKey: "post_author_missing" },
				post_org_id_fk: { cause: "org", errorKey: "post_org_missing" },
			},
			primaryKey: { cause: "id", errorKey: "post_id_taken" },
		},
	}

	const thrown = (fn: () => void): CombError => {
		try {
			fn()
		} catch (e) {
			return e as CombError
		}
		throw new Error("expected a CombError")
	}

	it("maps a foreign key violation by column from the detail", () => {
		const err = thrown(() =>
			pgErrorHandler(pgError("23503", { detail: "Key (author_id)=(x) is not present.", table: "post" }), [map]),
		)
		expect(err.errorKey).toBe("post_author_missing")
		expect(err.column).toBe("author_id")
		expect(err.status).toBe(409)
	})

	it("falls back to the constraint name when the detail names no column", () => {
		const err = thrown(() => pgErrorHandler(pgError("23503", { constraint: "post_org_id_fk", table: "post" }), [map]))
		expect(err.errorKey).toBe("post_org_missing")
		expect(err.column).toBe("post_org_id_fk")
	})

	it("maps a primary key violation with no column", () => {
		const err = thrown(() => pgErrorHandler(pgError("23000", { table: "post" }), [map]))
		expect(err.errorKey).toBe("post_id_taken")
		expect(err.table).toBe("post")
		expect(err.column).toBeUndefined()
	})

	it("maps a check violation by constraint name and defaults to bad_request", () => {
		const err = thrown(() =>
			pgErrorHandler(pgError("23514", { constraint: "post_status_check", table: "post" }), [map]),
		)
		expect(err.errorKey).toBe("post_status_invalid")
		expect(err.status).toBe(400)
	})

	it("falls back to a generic domain error when the constraint is unmapped", () => {
		/* Unmapped is still a known class of failure — it degrades to the generic
		   key rather than leaking a raw driver error to the caller. */
		const fk = thrown(() => pgErrorHandler(pgError("23503", { constraint: "unknown_fk", table: "post" }), [map]))
		expect(fk.errorKey).toBe("foreign_key_violation")
		expect(fk.status).toBe(409)

		const check = thrown(() => pgErrorHandler(pgError("23514", { constraint: "unknown_check", table: "post" }), [map]))
		expect(check.errorKey).toBe("check_constraint_violation")
		expect(check.status).toBe(400)

		const pk = thrown(() => pgErrorHandler(pgError("23000", { table: "other" }), [map]))
		expect(pk.errorKey).toBe("primary_key_violation")
	})

	it("maps a not-null violation to a required-field error", () => {
		const err = thrown(() => pgErrorHandler(pgError("23502", { table: "post" }), [map]))
		expect(err.errorKey).toBe("required_field_missing")
		expect(err.status).toBe(400)
	})

	it("degrades a unique violation with no mapping to the generic key", () => {
		const err = thrown(() => pgErrorHandler(pgError("23505", { table: "post" }), [map]))
		expect(err.errorKey).toBe("unique_constraint_violation")
		expect(err.table).toBe("post")
	})

	it("searches every supplied constraint map", () => {
		const err = thrown(() => pgErrorHandler(pgError("23000", { table: "post" }), [{}, map]))
		expect(err.errorKey).toBe("post_id_taken")
	})
})
