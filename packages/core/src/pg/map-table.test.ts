import { describe, expect, it } from "vitest"
import type { ConstraintMap } from "../types.ts"
import { classifyPgError, readPgError } from "./error-handler.ts"
import { mapTable } from "./map-table.ts"

const entry = (errorKey: string) => ({ cause: errorKey, errorKey })
/* Supabase's auth.users beside the app's own users, which lives in the configured schema */
const MAPS: ConstraintMap[] = [
	{
		"auth.users": { unique: { email: entry("auth_users_email_duplicate") } },
		users: { unique: { email: entry("users_email_duplicate") } },
	},
]
const BARE: ConstraintMap[] = [{ users: { unique: { email: entry("users_email_duplicate") } } }]

/** A node-postgres unique violation on `schema`.`users`'s email */
const duplicate = (schema: string) =>
	Object.assign(new Error("server error"), {
		code: "23505",
		constraint: "users_email_key",
		detail: "Key (email)=(a@b.c) already exists.",
		schema,
		table: "users",
	})

/* F51: two tables of one name in two schemas, each its own entry */
describe("mapTable: the map key of a violated Postgres table (F51)", () => {
	it("takes schema.table first, and the bare table for a schema no qualified entry names", () => {
		expect(mapTable(MAPS, { schema: "auth", table: "users" })).toBe("auth.users")
		expect(mapTable(MAPS, { schema: "public", table: "users" })).toBe("users")
		/* an unqualified table lives in the configured schema (search_path), comb's own app among them */
		expect(mapTable(BARE, { schema: "app", table: "users" })).toBe("users")
		expect(mapTable(MAPS, { schema: "x", table: "users" })).toBe("users")
		expect(mapTable(MAPS, { schema: undefined, table: "users" })).toBe("users")
		expect(mapTable(MAPS, { schema: "auth", table: undefined })).toBeUndefined()
	})

	it("never gives a schema'd table another schema's bare entry", () => {
		const authOnly: ConstraintMap[] = [{ "auth.sessions": {}, users: {} }]
		expect(mapTable(authOnly, { schema: "auth", table: "users" })).toBe("auth.users")
	})

	it("answers each schema's violation with its own entry, and names the table qualified", () => {
		expect(classifyPgError(duplicate("auth"), MAPS)).toMatchObject({
			errorKey: "auth_users_email_duplicate",
			table: "auth.users",
		})
		expect(classifyPgError(duplicate("public"), MAPS)).toMatchObject({
			errorKey: "users_email_duplicate",
			table: "users",
		})
		expect(classifyPgError(duplicate("app"), BARE)).toMatchObject({ errorKey: "users_email_duplicate" })
	})

	it("reads the schema each driver names: node-postgres and Bun.SQL on schema, postgres.js on schema_name", () => {
		const fields = { code: "23505", table: "users" }
		expect(readPgError(Object.assign(new Error("e"), { ...fields, schema: "auth" }))?.schema).toBe("auth")
		expect(readPgError(Object.assign(new Error("e"), { ...fields, schema_name: "auth" }))?.schema).toBe("auth")
		expect(
			readPgError(Object.assign(new Error("e"), { ...fields, code: undefined, errno: "23505", schema: "auth" }))
				?.schema,
		).toBe("auth")
	})
})
