import { describe, expect, it } from "vitest"
import { CombError } from "../error.ts"
import type { ConstraintMap } from "../types.ts"
import { pgErrorHandler, readPgError } from "./error-handler.ts"

/* driver shapes as node-postgres, postgres.js and Bun.SQL produce them; the real-server cases
 * live in tests/integration/postgres and tests/bun */
const nodePg = (fields: Record<string, string>) => Object.assign(new Error("server error"), fields)
const postgresJs = (fields: Record<string, string>) => Object.assign(new Error("server error"), fields)
const bunSql = (fields: Record<string, string>) =>
	Object.assign(new Error("server error"), { code: "ERR_POSTGRES_SERVER_ERROR", ...fields })
const wrapped = (cause: unknown) =>
	Object.assign(new Error("Failed query: insert ...", { cause }), { name: "DrizzleQueryError", query: "insert ..." })

const MAPS: ConstraintMap[] = [
	{
		store: {
			check: { store_price_check: { cause: "Price must be positive", errorKey: "store_price_invalid" } },
			foreignKey: {
				owner_id: { cause: "No such owner", errorKey: "store_owner_missing" },
				store_region_fkey: { cause: "No such region", errorKey: "store_region_missing" },
			},
			primaryKey: { cause: "Store exists", errorKey: "store_id_taken" },
			unique: {
				slug: { cause: "Slug taken", errorKey: "store_slug_taken" },
				store_name_key: { cause: "Name taken", errorKey: "store_name_taken" },
			},
		},
		legacy: { unique: { id: { cause: "Legacy id", errorKey: "legacy_id_taken" } } },
	},
]

const pk = (table: string) =>
	nodePg({ code: "23505", constraint: `${table}_pkey`, detail: "Key (id)=(1) already exists.", table })
const fk = (fields: Record<string, string>) => thrown(nodePg({ code: "23503", table: "store", ...fields }))

function thrown(error: unknown, maps = MAPS): CombError | undefined {
	try {
		pgErrorHandler(error, maps)
	} catch (caught) {
		return caught as CombError
	}
	return undefined
}

describe("readPgError", () => {
	it("reads every driver's field names, through wrappers", () => {
		const expected = { code: "23505", column: "c", constraint: "k", keyColumns: ["a", "b"], table: "t" }
		const detail = 'Key (a, "b")=(1, 2) already exists.'
		expect(readPgError(wrapped(nodePg({ code: "23505", column: "c", constraint: "k", detail, table: "t" })))).toEqual(
			expected,
		)
		expect(
			readPgError(postgresJs({ code: "23505", column_name: "c", constraint_name: "k", detail, table_name: "t" })),
		).toEqual(expected)
		expect(readPgError(bunSql({ column: "c", constraint: "k", detail, errno: "23505", table: "t" }))).toEqual(expected)
	})

	it("is null without a SQLSTATE", () => {
		expect(readPgError(new Error("x"))).toBeNull()
		expect(readPgError(Object.assign(new Error("x"), { code: "SQLITE_CONSTRAINT" }))).toBeNull()
		expect(readPgError(bunSql({}))).toBeNull()
		expect(readPgError(null)).toBeNull()
		expect(readPgError("23505")).toBeNull()
	})

	it("treats empty fields as absent", () => {
		expect(readPgError(nodePg({ code: "23502", column: "", table: "" }))).toMatchObject({
			column: undefined,
			table: undefined,
		})
	})
})

describe("pgErrorHandler: unique and primary key", () => {
	it("maps a unique column from detail, then by constraint name, else the generic key", () => {
		expect(thrown(nodePg({ code: "23505", detail: "Key (slug)=(x) already exists.", table: "store" }))).toMatchObject({
			column: "slug",
			errorKey: "store_slug_taken",
			status: 409,
		})
		expect(thrown(nodePg({ code: "23505", constraint: "store_name_key", table: "store" }))).toMatchObject({
			errorKey: "store_name_taken",
		})
		expect(thrown(nodePg({ code: "23505", detail: "Key (x)=(1) already exists.", table: "store" }))).toMatchObject({
			cause: "Duplicate value for store.x",
			errorKey: "unique_constraint_violation",
		})
		expect(thrown(nodePg({ code: "23505", detail: "Key (x)=(1) already exists." }))).toMatchObject({
			cause: "Duplicate value for x",
		})
		expect(thrown(nodePg({ code: "23505" }))).toMatchObject({ cause: "Duplicate value detected" })
	})

	it("recognizes the primary key by its <table>_pkey constraint", () => {
		expect(thrown(pk("store"))).toMatchObject({ column: undefined, errorKey: "store_id_taken" })
		expect(thrown(pk("legacy"))).toMatchObject({ errorKey: "legacy_id_taken" })
		expect(thrown(pk("other"))).toMatchObject({ errorKey: "primary_key_violation", table: "other" })
	})
})

describe("pgErrorHandler: foreign key, check, not null", () => {
	it("maps a foreign key by column, then by constraint name, else the generic key", () => {
		expect(fk({ detail: 'Key (owner_id)=(9) is not present in table "owner".' })).toMatchObject({
			column: "owner_id",
			errorKey: "store_owner_missing",
		})
		expect(fk({ constraint: "store_region_fkey" })).toMatchObject({ errorKey: "store_region_missing" })
		expect(fk({ constraint: "store_other_fkey" })).toMatchObject({ errorKey: "foreign_key_violation" })
	})

	it("maps a CHECK by name in its table, or in any table when the table is unknown", () => {
		expect(thrown(nodePg({ code: "23514", constraint: "store_price_check", table: "store" }))).toMatchObject({
			errorKey: "store_price_invalid",
			status: 400,
		})
		expect(thrown(nodePg({ code: "23514", constraint: "store_price_check", table: "legacy" }))).toMatchObject({
			errorKey: "check_constraint_violation",
		})
		expect(thrown(nodePg({ code: "23514", constraint: "store_price_check" }))).toMatchObject({
			errorKey: "store_price_invalid",
			table: "store",
		})
	})

	it("reports NOT NULL with the column the server names", () => {
		expect(thrown(nodePg({ code: "23502", column: "name", table: "store" }))).toMatchObject({
			cause: "Required field missing: name",
			column: "name",
			errorKey: "required_field_missing",
		})
		expect(thrown(nodePg({ code: "23502" }))).toMatchObject({ cause: "Required field missing" })
	})
})

describe("pgErrorHandler: resources and everything else", () => {
	it.each([
		["53100", "tier_database_limit_reached", 422],
		["53000", "database_io_error", 500],
		["53200", "database_io_error", 500],
		["08006", "database_unavailable", 503],
		["08001", "database_unavailable", 503],
		["57P01", "database_readonly", 503],
		["25006", "database_readonly", 503],
		["57P03", "database_unavailable", 503],
	])("maps %s", (code, errorKey, status) => {
		expect(thrown(nodePg({ code }))).toMatchObject({ errorKey, status })
	})

	it("leaves other errors alone and keeps the original on source", () => {
		expect(thrown(nodePg({ code: "42703" }))).toBeUndefined()
		expect(thrown(new Error("x"))).toBeUndefined()
		const source = nodePg({ code: "53100" })
		expect(thrown(source)?.source).toBe(source)
	})
})

describe("pgErrorHandler: retryable transaction failures", () => {
	it.each(["40001", "40P01", "57014"])("maps %s to a retryable 503", (code) => {
		expect(thrown(nodePg({ code }))).toMatchObject({
			cause: "The database could not finish the transaction. Please retry.",
			errorKey: "database_unavailable",
			status: 503,
		})
	})
})

describe("readPgError on a wrapper that carries its own code", () => {
	it("reads the driver error under it: the server's error is the deepest", () => {
		const driver = nodePg({ code: "23505", constraint: "store_slug_key", table: "store" })
		const appWrapper = Object.assign(new Error("request failed: 57014"), { cause: driver, code: "57014" })
		expect(readPgError(appWrapper)).toMatchObject({ code: "23505", constraint: "store_slug_key" })
	})
})
