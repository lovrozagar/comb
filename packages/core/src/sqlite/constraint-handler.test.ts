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
		/* a delete fails on a row that still references the deleted one, never on the store's own key */
		expect(fk('delete from "store" where "id" = ?')).toMatchObject({
			cause: "The record is still referenced by other records",
			column: undefined,
			errorKey: "foreign_key_violation",
			table: "store",
		})
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

/** The error a foreign key violation recorded with `query` becomes */
const fk = (query: string) =>
	thrown(wrapped(engine("SQLITE_CONSTRAINT_FOREIGNKEY", "FOREIGN KEY constraint failed"), query))

describe("sqliteErrorHandler: the statement behind a foreign key violation", () => {
	it("reads a delete behind a CTE or a comment as a delete, and a CTE's name as nothing", () => {
		/* a delete behind a CTE or a comment is still a delete */
		for (const query of [
			'with gone as (select "id" from "old") delete from "store" where "id" in (select "id" from gone)',
			'/* purge */ delete from "store" where "id" = ?',
			'-- purge\ndelete from "store" where "id" = ?',
		]) {
			expect(fk(query)).toMatchObject({ cause: "The record is still referenced by other records", column: undefined })
		}
		/* a write whose CTE only reads with a delete-like name is not one */
		expect(fk('with "delete" as (select 1) insert into "store" ("id", "owner_id") values (?, ?)')).toMatchObject({
			errorKey: "store_owner_missing",
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

describe("handleConstraintViolation given a message string", () => {
	it.each([
		["UNIQUE constraint failed: store.slug", "store_slug_taken"],
		["SQLITE_CONSTRAINT: UNIQUE constraint failed: store.slug", "store_slug_taken"],
		[
			"D1_ERROR: UNIQUE constraint failed: store.slug: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)",
			"store_slug_taken",
		],
		[
			"D1_ERROR: UNIQUE constraint failed: store.id: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_PRIMARYKEY)",
			"store_id_taken",
		],
		["CHECK constraint failed: store_price_check", "store_price_invalid"],
		["NOT NULL constraint failed: store.name", "required_field_missing"],
		["FOREIGN KEY constraint failed", "foreign_key_violation"],
	])("classifies %s", (message, errorKey) => {
		expect(() => handleConstraintViolation(message, MAPS)).toThrow(expect.objectContaining({ errorKey }))
	})

	it("leaves a message that is no constraint violation alone", () => {
		expect(() => handleConstraintViolation("no such column: x", MAPS)).not.toThrow()
		expect(() => handleConstraintViolation("", MAPS)).not.toThrow()
	})
})

const failing = (query: string) =>
	wrapped(engine("SQLITE_CONSTRAINT_CHECK", "CHECK constraint failed: status_check"), query)

describe("constraintError: a CHECK name two tables share", () => {
	const shared: ConstraintMap[] = [
		{
			invoice: { check: { status_check: { cause: "Invoice status", errorKey: "invoice_status_invalid" } } },
			order: { check: { status_check: { cause: "Order status", errorKey: "order_status_invalid" } } },
		},
	]

	it("resolves the statement's table first", () => {
		expect(constraintError(failing('insert into "order" ("status") values (?)'), shared)).toMatchObject({
			errorKey: "order_status_invalid",
			table: "order",
		})
		expect(constraintError(failing('update "invoice" set "status" = ?'), shared)).toMatchObject({
			errorKey: "invoice_status_invalid",
		})
	})

	it("searches every table only when the statement's table is unknown", () => {
		expect(
			constraintError(engine("SQLITE_CONSTRAINT_CHECK", "CHECK constraint failed: status_check"), shared),
		).toMatchObject({
			errorKey: "invoice_status_invalid",
		})
	})
})

describe("handleConstraintViolation given 0.4.x's flattened message", () => {
	it("classifies nothing in text that carries a params line: a bound value may write the engine's words", () => {
		const maps: ConstraintMap[] = [
			{ user: { check: { user_status_enum: { cause: "Invalid status", errorKey: "invalid_status" } } } },
		]
		const flattened =
			'Failed query: insert into "user" (id) values (?)\nparams: u1\nCHECK constraint failed: user_status_enum'
		expect(() => handleConstraintViolation(flattened, maps)).not.toThrow()
		expect(() => handleConstraintViolation("CHECK constraint failed: user_status_enum", maps)).toThrow(
			expect.objectContaining({ errorKey: "invalid_status" }),
		)
	})
})

describe("constraint errors that carry only the base SQLITE_CONSTRAINT code", () => {
	const maps: ConstraintMap[] = [
		{
			user: {
				check: { user_age_check: { cause: "Age", errorKey: "user_age_invalid" } },
				unique: {
					email_address: { cause: "Email", errorKey: "user_email_taken" },
					handle_name: { cause: "Handle", errorKey: "user_handle_taken" },
				},
			},
		},
	]

	it.each([
		["D1_ERROR: UNIQUE constraint failed: user.email_address: SQLITE_CONSTRAINT", "user_email_taken"],
		["UNIQUE constraint failed: user.handle_name: SQLITE_CONSTRAINT", "user_handle_taken"],
		["D1_ERROR: CHECK constraint failed: user_age_check: SQLITE_CONSTRAINT", "user_age_invalid"],
		["D1_ERROR: NOT NULL constraint failed: user.name: SQLITE_CONSTRAINT", "required_field_missing"],
		["D1_ERROR: FOREIGN KEY constraint failed: SQLITE_CONSTRAINT", "foreign_key_violation"],
	])("infers the kind from the wording: %s", (message, errorKey) => {
		expect(() => handleConstraintViolation(message, maps)).toThrow(expect.objectContaining({ errorKey }))
		expect(() => handleConstraintViolation(new Error(message), maps)).toThrow(expect.objectContaining({ errorKey }))
	})

	it("does so for a driver error with code SQLITE_CONSTRAINT and no extended code", () => {
		const error = engine("SQLITE_CONSTRAINT", "UNIQUE constraint failed: user.email_address")
		expect(() => handleConstraintViolation(error, maps)).toThrow(
			expect.objectContaining({ errorKey: "user_email_taken" }),
		)
	})
})

/** A UNIQUE violation of the expression index `name`, which SQLite names instead of columns */
const index = (name: string) => engine("SQLITE_CONSTRAINT_UNIQUE", `UNIQUE constraint failed: index '${name}'`)

describe("constraintError: a unique index on an expression (Q9)", () => {
	const maps: ConstraintMap[] = [
		{
			account: { unique: { u_email_lower: { cause: "Email taken", errorKey: "email_taken" } } },
			other: { unique: { u_handle: { cause: "Handle taken", errorKey: "handle_taken" } } },
		},
	]

	it("finds the index by name in the statement's table, then in any table, as Postgres finds the constraint", () => {
		expect(thrown(wrapped(index("u_email_lower"), 'insert into "account" ("email") values (?)'), maps)).toMatchObject({
			cause: "Email taken",
			errorKey: "email_taken",
			status: 409,
			table: "account",
		})
		expect(thrown(index("u_handle"), maps)).toMatchObject({ errorKey: "handle_taken", table: "other" })
		expect(thrown(index("u_unknown"), maps)).toMatchObject({
			cause: "Duplicate value detected",
			errorKey: "unique_constraint_violation",
			table: undefined,
		})
	})
})

describe("constraintError: a value the column cannot hold (Q10)", () => {
	it("answers a STRICT type mismatch with the 400 Postgres gives, naming the column, never the value", () => {
		expect(
			thrown(engine("SQLITE_CONSTRAINT_DATATYPE", "cannot store TEXT value in INTEGER column s.n"), []),
		).toMatchObject({ cause: "Invalid value for n", column: "n", errorKey: "invalid_value", status: 400, table: "s" })
		expect(thrown(engine("SQLITE_MISMATCH", "datatype mismatch"), [])).toMatchObject({
			cause: "Invalid value",
			errorKey: "invalid_value",
			status: 400,
		})
	})

	it("answers a value too big for the engine with value_too_large", () => {
		expect(() => sqliteErrorHandler(engine("SQLITE_TOOBIG", "string or blob too big"), [])).toThrow(
			expect.objectContaining({ cause: "Value too large", errorKey: "value_too_large", status: 400 }),
		)
	})
})
