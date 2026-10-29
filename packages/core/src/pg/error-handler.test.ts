import { describe, expect, it } from "vitest"
import { CombError } from "../error.ts"
import type { ConstraintMap } from "../types.ts"
import { classifyPgError, pgErrorHandler } from "./error-handler.ts"

/* a server error as node-postgres hands it over; read-error.test.ts reads the other drivers'
 * shapes, and the real-server cases live in tests/integration/postgres and tests/bun */
const nodePg = (fields: Record<string, string>) => Object.assign(new Error("server error"), fields)

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
		["57P01", "database_unavailable", 503],
		["25006", "database_readonly", 503],
		["57P03", "database_unavailable", 503],
		["53300", "database_unavailable", 503],
		["53400", "database_unavailable", 503],
		["55P03", "database_unavailable", 503],
		["57P05", "database_unavailable", 503],
		["25P03", "database_unavailable", 503],
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

describe("pgErrorHandler: which side of a foreign key failed, and long table names", () => {
	it("says a row is still referenced when the detail says so, naming no column", () => {
		const error = nodePg({ code: "23503", detail: 'Key (id)=(10) is still referenced from table "c".', table: "c" })
		const maps = [{ c: { foreignKey: { id: { cause: "No such parent", errorKey: "c_parent_missing" } } } }]
		const caught = thrown(error, maps)
		expect(caught).toMatchObject({
			cause: "The record is still referenced by other records",
			errorKey: "foreign_key_violation",
		})
		expect(caught?.column).toBeUndefined()
	})

	/* U8 of the 0.12 round */
	it("names the parent of a schema-qualified delete, not its schema", () => {
		const driver = nodePg({ code: "23503", detail: 'Key (id)=(10) is still referenced from table "c".', table: "c" })
		const query = 'delete from "app"."parent" where "id" = $1'
		const error = Object.assign(new Error(`Failed query: ${query}`, { cause: driver }), {
			name: "DrizzleQueryError",
			query,
		})
		expect(thrown(error, [])).toMatchObject({ errorKey: "foreign_key_violation", table: "parent" })
	})

	it("reads a missing parent as such when the child's key value spells the referenced phrase (Q-D6)", () => {
		const error = nodePg({
			code: "23503",
			detail: 'Key (pcode)=(x is still referenced from table "ch".) is not present in table "parent".',
			table: "ch",
		})
		const maps = [{ ch: { foreignKey: { pcode: { cause: "Parent code is unknown", errorKey: "ch_pcode_missing" } } } }]
		expect(thrown(error, maps)).toMatchObject({ column: "pcode", errorKey: "ch_pcode_missing" })
	})

	it("finds the primary key of a table whose name Postgres cut, at a character boundary", () => {
		/* 57 ASCII bytes and a 2-byte é: 59 bytes, so the cut drops the é rather than half of it */
		const table = `${"t".repeat(57)}é`
		const maps = [{ [table]: { primaryKey: { cause: "Exists", errorKey: "long_taken" } } }]
		const error = nodePg({ code: "23505", constraint: `${"t".repeat(57)}_pkey`, table })
		expect(thrown(error, maps)).toMatchObject({ errorKey: "long_taken" })
	})
})

describe("pgErrorHandler: a value the column cannot hold (Q-D11)", () => {
	it.each(["22003", "22P02", "22007", "22008"])("maps %s to a 400 that names the column, never the value", (code) => {
		expect(thrown(nodePg({ code, column: "n", message: 'value "99999999999" is out of range' }))).toMatchObject({
			cause: "Invalid value for n",
			column: "n",
			errorKey: "invalid_value",
			status: 400,
		})
		expect(thrown(nodePg({ code }))).toMatchObject({ cause: "Invalid value", errorKey: "invalid_value" })
	})

	it("leaves division by zero, which the server's own SQL makes, alone", () => {
		expect(thrown(nodePg({ code: "22012" }))).toBeUndefined()
	})
})

/** An EXCLUDE violation on booking, of `constraint` */
const overlap = (constraint: string) => nodePg({ code: "23P01", constraint, table: "booking" })

describe("pgErrorHandler: more values a request can send (Q8)", () => {
	it.each(["22001", "22021", "22P05"])("maps %s, a value the column cannot hold, to invalid_value", (code) => {
		expect(thrown(nodePg({ code, column: "name" }))).toMatchObject({ errorKey: "invalid_value", status: 400 })
	})

	it("maps 54000, a value too large for an index row, to value_too_large", () => {
		expect(thrown(nodePg({ code: "54000" }))).toMatchObject({
			cause: "Value too large",
			errorKey: "value_too_large",
			status: 400,
		})
	})

	it("maps 23P01 through the map's exclusion entries, else to a 409", () => {
		const maps: ConstraintMap[] = [
			{ booking: { exclusion: { booking_no_overlap: { cause: "Room booked", errorKey: "room_booked" } } } },
		]
		expect(thrown(overlap("booking_no_overlap"), maps)).toMatchObject({
			cause: "Room booked",
			errorKey: "room_booked",
			status: 409,
			table: "booking",
		})
		expect(thrown(overlap("other"), maps)).toMatchObject({
			errorKey: "exclusion_constraint_violation",
			status: 409,
		})
	})
})

describe("pgErrorHandler: a trigger's RAISE EXCEPTION", () => {
	it("says a constraint was violated when the RAISE gave no message", () => {
		expect(thrown(nodePg({ code: "P0001", message: "" }))).toMatchObject({
			cause: "Constraint violated",
			errorKey: "constraint_violation",
		})
	})

	it("maps P0001 to a 400 constraint_violation with the message it raised", () => {
		expect(thrown(nodePg({ code: "P0001", message: "qty must be positive" }))).toMatchObject({
			cause: "qty must be positive",
			errorKey: "constraint_violation",
			status: 400,
		})
	})
})

/** What `handler` throws for `error`, or undefined when it throws nothing */
function thrownBy(handler: (error: unknown) => void, error: unknown): unknown {
	try {
		handler(error)
	} catch (error_) {
		return error_
	}
	return undefined
}

describe("classifyPgError: what pgErrorHandler would throw, thrown by nobody (C6)", () => {
	it.each([
		[
			"a unique violation",
			nodePg({ code: "23505", constraint: "k", detail: "Key (a)=(1) already exists.", table: "t" }),
		],
		["a value the column cannot hold", nodePg({ code: "22P02" })],
		["a server shutting down", nodePg({ code: "57P01" })],
		["a code comb does not map", nodePg({ code: "42601" })],
		["no server error", new Error("boom")],
	])("returns for %s what the handler throws, or undefined when it throws nothing", (_, error) => {
		expect(classifyPgError(error, MAPS)).toEqual(thrownBy((e) => pgErrorHandler(e, MAPS), error))
	})
})

/* Q14 of r17: each driver's own words for a connection refused or lost, as the drivers were seen to throw them */
/** An error as a driver throws it: its message, and its code when it has one */
const driver = (code: string | undefined, message: string) =>
	Object.assign(new Error(message), code === undefined ? {} : { code })

describe("classifyPgError on a lost connection", () => {
	it.each([
		["postgres.js and pg, refused", driver("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:1")],
		["postgres.js, reset", driver("ECONNRESET", "read ECONNRESET")],
		["a timeout", driver("ETIMEDOUT", "connect ETIMEDOUT")],
		["a broken pipe", driver("EPIPE", "write EPIPE")],
		["postgres.js, closed", driver("CONNECTION_CLOSED", "write CONNECTION_CLOSED 127.0.0.1:5432")],
		["postgres.js, connect timeout", driver("CONNECT_TIMEOUT", "write CONNECT_TIMEOUT 127.0.0.1:5432")],
		["Bun.SQL, refused", driver("ERR_POSTGRES_CONNECTION_REFUSED", "Failed to connect")],
		["pg, its client broken", driver(undefined, "Client has encountered a connection error and is not queryable")],
	])("answers %s as database_unavailable 503", (_label, error) => {
		expect(classifyPgError(error, [])).toMatchObject({ errorKey: "database_unavailable", status: 503 })
	})

	it("answers an error of no driver's connection words as nothing", () => {
		expect(classifyPgError(driver("ENOENT", "no such file"), [])).toBeUndefined()
		expect(classifyPgError(driver(undefined, "connection error"), [])).toBeUndefined()
	})
})
