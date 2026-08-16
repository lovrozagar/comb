import { describe, expect, it } from "vitest"
import { CombError } from "../../../src/error.ts"
import { extractTableColumn, handleConstraintViolation } from "../../../src/sqlite/constraint-handler.ts"
import type { ConstraintMap } from "../../../src/types.ts"

describe("extractTableColumn", () => {
	it("extracts table and column from UNIQUE constraint message", () => {
		const result = extractTableColumn("UNIQUE constraint failed: store.slug")
		expect(result).toEqual({ column: "slug", table: "store" })
	})

	it("extracts from FOREIGN KEY message", () => {
		const result = extractTableColumn("FOREIGN KEY constraint failed: order.user_id")
		expect(result).toEqual({ column: "user_id", table: "order" })
	})

	it("returns nulls for unrecognized format", () => {
		const result = extractTableColumn("some other error")
		expect(result).toEqual({ column: null, table: null })
	})
})

describe("handleConstraintViolation", () => {
	const constraintMap: ConstraintMap = {
		user: {
			primaryKey: {
				cause: "User already exists",
				errorKey: "user_pk_duplicate",
			},
			unique: {
				email: {
					cause: "Email already taken",
					errorKey: "user_email_unique",
					statusKey: "conflict",
				},
			},
		},
	}

	it("does nothing for non-constraint messages", () => {
		expect(() => handleConstraintViolation("some random error", [constraintMap])).not.toThrow()
	})

	it("throws CombError for mapped unique constraint", () => {
		try {
			handleConstraintViolation("UNIQUE constraint failed: user.email", [constraintMap])
			expect.unreachable("should have thrown")
		} catch (e) {
			expect(e).toBeInstanceOf(CombError)
			const err = e as CombError
			expect(err.errorKey).toBe("user_email_unique")
			expect(err.statusKey).toBe("conflict")
			expect(err.table).toBe("user")
			expect(err.column).toBe("email")
		}
	})

	it("throws CombError for mapped primary key constraint", () => {
		try {
			handleConstraintViolation("PRIMARY KEY constraint failed: user.id", [constraintMap])
			expect.unreachable("should have thrown")
		} catch (e) {
			expect(e).toBeInstanceOf(CombError)
			const err = e as CombError
			expect(err.errorKey).toBe("user_pk_duplicate")
			expect(err.table).toBe("user")
		}
	})

	it("throws fallback CombError for unmapped unique constraint", () => {
		try {
			handleConstraintViolation("UNIQUE constraint failed: post.slug", [constraintMap])
			expect.unreachable("should have thrown")
		} catch (e) {
			expect(e).toBeInstanceOf(CombError)
			const err = e as CombError
			expect(err.errorKey).toBe("unique_constraint_violation")
			expect(err.status).toBe(409)
			expect(err.table).toBe("post")
			expect(err.column).toBe("slug")
		}
	})

	it("throws fallback for unmapped foreign key", () => {
		try {
			handleConstraintViolation("FOREIGN KEY constraint failed: order.user_id", [constraintMap])
			expect.unreachable("should have thrown")
		} catch (e) {
			expect(e).toBeInstanceOf(CombError)
			const err = e as CombError
			expect(err.errorKey).toBe("foreign_key_violation")
		}
	})

	it("throws fallback for not null violation", () => {
		try {
			handleConstraintViolation("NOT NULL constraint failed: user.name", [constraintMap])
			expect.unreachable("should have thrown")
		} catch (e) {
			expect(e).toBeInstanceOf(CombError)
			const err = e as CombError
			expect(err.errorKey).toBe("required_field_missing")
			expect(err.status).toBe(400)
		}
	})

	it("throws fallback for check constraint", () => {
		try {
			handleConstraintViolation("CHECK constraint failed: user.age", [constraintMap])
			expect.unreachable("should have thrown")
		} catch (e) {
			expect(e).toBeInstanceOf(CombError)
			const err = e as CombError
			expect(err.errorKey).toBe("check_constraint_violation")
			expect(err.status).toBe(400)
		}
	})
})

describe("handleConstraintViolation — remaining constraint classes", () => {
	const map: ConstraintMap = {
		post: {
			check: { post_status_check: { cause: "status", errorKey: "post_status_invalid" } },
			foreignKey: { author_id: { cause: "author", errorKey: "post_author_missing" } },
			primaryKey: { cause: "id", errorKey: "post_id_taken" },
		},
		tagged: {
			foreignKey: {
				a_id: { cause: "a", errorKey: "a_missing" },
				b_id: { cause: "b", errorKey: "b_missing" },
			},
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

	it("resolves a single-column foreign key even though SQLite names no column", () => {
		/* SQLite says only "FOREIGN KEY constraint failed" — with one FK on the
		   table the mapping is unambiguous, so it is safe to use. */
		const err = thrown(() => handleConstraintViolation("FOREIGN KEY constraint failed: post.author_id", [map]))
		expect(err.errorKey).toBe("post_author_missing")
		expect(err.column).toBe("author_id")
	})

	it("declines to guess when the table has more than one foreign key", () => {
		const err = thrown(() => handleConstraintViolation("FOREIGN KEY constraint failed: tagged", [map]))
		/* falls through to the generic key rather than picking one at random */
		expect(err.errorKey).toBe("foreign_key_violation")
	})

	it("maps a primary key violation", () => {
		const err = thrown(() => handleConstraintViolation("PRIMARY KEY constraint failed: post.id", [map]))
		expect(err.errorKey).toBe("post_id_taken")
		expect(err.table).toBe("post")
	})

	it("maps a check violation, defaulting to bad_request", () => {
		const err = thrown(() => handleConstraintViolation("CHECK constraint failed: post.status", [map]))
		expect(err.errorKey).toBe("post_status_invalid")
		expect(err.status).toBe(400)
	})

	it("degrades to the generic key when the table is not in the map", () => {
		const err = thrown(() => handleConstraintViolation("PRIMARY KEY constraint failed: other.id", [map]))
		expect(err.errorKey).toBe("primary_key_violation")
	})
})
