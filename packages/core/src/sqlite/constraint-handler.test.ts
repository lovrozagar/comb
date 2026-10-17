import { describe, expect, it } from "vitest"
import { CombError } from "../error.ts"
import type { ConstraintMap } from "../types.ts"
import { constraintError, handleConstraintViolation, sqliteErrorHandler } from "./constraint-handler.ts"

/* bun:sqlite's shape: the extended code on `code`; the real-engine cases live in tests/integration/sqlite */
const engine = (code: string, message: string) => Object.assign(new Error(message), { code })
const wrapped = (cause: unknown, query: string) =>
	Object.assign(new Error(`Failed query: ${query}`, { cause }), { name: "DrizzleQueryError", query })

const MAPS: ConstraintMap[] = [
	{
		store: {
			check: { store_price_check: { cause: "Price must be positive", errorKey: "store_price_invalid" } },
			foreignKey: { owner_id: { cause: "No such owner", errorKey: "store_owner_missing", statusKey: "bad_request" } },
			primaryKey: { cause: "Store exists", errorKey: "store_id_taken" },
			unique: { slug: { cause: "Slug taken", errorKey: "store_slug_taken" } },
		},
		legacy: { unique: { id: { cause: "Legacy id taken", errorKey: "legacy_id_taken" } } },
		multi: { foreignKey: { a_id: { cause: "a", errorKey: "a" }, b_id: { cause: "b", errorKey: "b" } } },
	},
]

function thrown(error: unknown, maps = MAPS): CombError {
	const mapped = constraintError(error, maps)
	if (mapped === null) throw new Error("not mapped")
	return mapped
}

describe("constraintError: unique and primary key", () => {
	it("maps a unique column and falls back to the generic key", () => {
		expect(thrown(engine("SQLITE_CONSTRAINT_UNIQUE", "UNIQUE constraint failed: store.slug"))).toMatchObject({
			cause: "Slug taken",
			column: "slug",
			errorKey: "store_slug_taken",
			status: 409,
			table: "store",
		})
		expect(thrown(engine("SQLITE_CONSTRAINT_UNIQUE", "UNIQUE constraint failed: store.name"))).toMatchObject({
			cause: "Duplicate value for store.name",
			errorKey: "unique_constraint_violation",
		})
		expect(thrown(engine("SQLITE_CONSTRAINT_UNIQUE", "UNIQUE constraint failed"))).toMatchObject({
			cause: "Duplicate value detected",
			column: undefined,
			table: undefined,
		})
	})

	it("maps the primary key, a legacy unique entry for the key column, or the generic key", () => {
		expect(thrown(engine("SQLITE_CONSTRAINT_PRIMARYKEY", "UNIQUE constraint failed: store.id"))).toMatchObject({
			errorKey: "store_id_taken",
			status: 409,
		})
		expect(thrown(engine("SQLITE_CONSTRAINT_PRIMARYKEY", "UNIQUE constraint failed: legacy.id"))).toMatchObject({
			errorKey: "legacy_id_taken",
		})
		expect(thrown(engine("SQLITE_CONSTRAINT_PRIMARYKEY", "UNIQUE constraint failed: other.id"))).toMatchObject({
			errorKey: "primary_key_violation",
			table: "other",
		})
	})

	it("ignores inherited names in maps and tables", () => {
		expect(thrown(engine("SQLITE_CONSTRAINT_UNIQUE", "UNIQUE constraint failed: store.constructor"))).toMatchObject({
			errorKey: "unique_constraint_violation",
		})
		expect(thrown(engine("SQLITE_CONSTRAINT_UNIQUE", "UNIQUE constraint failed: toString.slug"))).toMatchObject({
			errorKey: "unique_constraint_violation",
		})
	})
})

describe("constraintError: check, not null, foreign key", () => {
	it("maps a CHECK by name across tables, else the generic key", () => {
		expect(thrown(engine("SQLITE_CONSTRAINT_CHECK", "CHECK constraint failed: store_price_check"))).toMatchObject({
			errorKey: "store_price_invalid",
			status: 400,
			table: "store",
		})
		expect(thrown(engine("SQLITE_CONSTRAINT_CHECK", "CHECK constraint failed: price > 0"))).toMatchObject({
			errorKey: "check_constraint_violation",
			table: undefined,
		})
	})

	it("reports NOT NULL with its column, or without one", () => {
		expect(thrown(engine("SQLITE_CONSTRAINT_NOTNULL", "NOT NULL constraint failed: store.name"))).toMatchObject({
			cause: "Required field missing: name",
			column: "name",
			errorKey: "required_field_missing",
			table: "store",
		})
		expect(thrown(engine("SQLITE_CONSTRAINT_NOTNULL", "NOT NULL constraint failed"))).toMatchObject({
			cause: "Required field missing",
		})
	})

	it("finds the foreign key's table from the statement and its column when the table has one", () => {
		const fk = (query: string) =>
			thrown(wrapped(engine("SQLITE_CONSTRAINT_FOREIGNKEY", "FOREIGN KEY constraint failed"), query))
		expect(fk('insert into "store" ("id", "owner_id") values (?, ?)')).toMatchObject({
			column: "owner_id",
			errorKey: "store_owner_missing",
			status: 400,
			table: "store",
		})
		expect(fk('update "store" set "owner_id" = ?')).toMatchObject({ errorKey: "store_owner_missing" })
		expect(fk('delete from "store" where "id" = ?')).toMatchObject({ errorKey: "store_owner_missing" })
		expect(fk('insert into "legacy" ("id") values (?)')).toMatchObject({ errorKey: "foreign_key_violation" })
		expect(fk('insert into "multi" ("a_id") values (?)')).toMatchObject({
			column: undefined,
			errorKey: "foreign_key_violation",
			table: "multi",
		})
		expect(thrown(engine("SQLITE_CONSTRAINT_FOREIGNKEY", "FOREIGN KEY constraint failed"))).toMatchObject({
			errorKey: "foreign_key_violation",
			table: undefined,
		})
	})
})

describe("handleConstraintViolation and sqliteErrorHandler", () => {
	it("throw the mapped error, and leave non-constraint errors alone", () => {
		const unique = engine("SQLITE_CONSTRAINT_UNIQUE", "UNIQUE constraint failed: store.slug")
		expect(() => handleConstraintViolation(unique, MAPS)).toThrow(CombError)
		expect(() => sqliteErrorHandler(unique, MAPS)).toThrow(CombError)
		for (const other of [
			engine("SQLITE_CONSTRAINT_TRIGGER", "x"),
			engine("SQLITE_ERROR", "no such column: x"),
			new Error("x"),
			"x",
		]) {
			expect(() => handleConstraintViolation(other, MAPS)).not.toThrow()
			expect(() => sqliteErrorHandler(other, MAPS)).not.toThrow()
		}
		expect(constraintError(new Error("x"), MAPS)).toBeNull()
	})

	it("keeps the original error on source", () => {
		const unique = engine("SQLITE_CONSTRAINT_UNIQUE", "UNIQUE constraint failed: store.slug")
		expect(thrown(unique).source).toBe(unique)
	})

	it.each([
		["SQLITE_BUSY", "database_unavailable", 503],
		["SQLITE_BUSY_SNAPSHOT", "database_unavailable", 503],
		["SQLITE_LOCKED", "database_unavailable", 503],
		["SQLITE_FULL", "tier_database_limit_reached", 422],
		["SQLITE_READONLY", "database_readonly", 503],
	])("sqliteErrorHandler maps the resource code %s", (code, errorKey, status) => {
		expect(() => sqliteErrorHandler(engine(code, "x"), [])).toThrow(expect.objectContaining({ errorKey, status }))
		expect(() => handleConstraintViolation(engine(code, "x"), [])).not.toThrow()
	})
})
