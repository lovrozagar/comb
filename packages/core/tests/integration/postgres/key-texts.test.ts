/**
 * B2-8 of area B: AB1's invariant, checked on the server. A list carries a key's text only where the
 * driver's read rounds it, a numeric or a domain over one, and, on a list that binds the key as read,
 * a timestamp, timestamptz or date; every other type carries nothing, so no text holding a comma is
 * comma-joined. The unit test in list-finish.test.ts pins the type names the guard spells; this one
 * evaluates the guard for one value of each type a user can create and of every built-in category,
 * so an arm naming no type (`pg_typeof(k)::oid >= 16384`, AB1's original bug) fails here.
 */
import { sql } from "drizzle-orm"
import { PgDialect } from "drizzle-orm/pg-core"
import type pg from "pg"
import { describe, expect, it } from "vitest"
import { keyTextsSQL } from "../../../src/query/sqlite/key-texts.ts"
import { usePg } from "../support/pg.ts"

/* the types a user can create, each in the session's pg_temp */
const MADE = [
	"CREATE TYPE pg_temp.b8_mood AS ENUM ('calm')",
	"CREATE DOMAIN pg_temp.b8_label AS text",
	"CREATE DOMAIN pg_temp.b8_tag AS pg_temp.b8_label",
	"CREATE TYPE pg_temp.b8_pair AS (n numeric, t text)",
	"CREATE TYPE pg_temp.b8_span AS RANGE (subtype = numeric)",
	"CREATE DOMAIN pg_temp.b8_amount AS numeric",
]

/* a value of each type, by what a list carries for it: always, only as read, or never */
const ROUNDED = ["1.5::numeric", "1.5::pg_temp.b8_amount"]
const TIMES = [
	"'2024-01-01'::date",
	"'2024-01-01 00:00:00.123456'::timestamp",
	"'2024-01-01 00:00:00.123456+00'::timestamptz",
]
const NEVER = [
	"'calm'::pg_temp.b8_mood",
	"'a,b'::pg_temp.b8_label",
	"'a,b'::pg_temp.b8_tag",
	"row(1.5, 'a,b')::pg_temp.b8_pair",
	"'[1.5,2)'::pg_temp.b8_span",
	"'{[1.5,2)}'::pg_temp.b8_span_multirange",
	"true",
	"'a,b'::text",
	"'a,b'::varchar",
	"'a'::name",
	"'\\x00'::bytea",
	"'00000000-0000-0000-0000-000000000000'::uuid",
	`'{"a":1}'::json`,
	`'{"a":1}'::jsonb`,
	"'1 day'::interval",
	"'12:00'::time",
	"'12:00+00'::timetz",
	"'10.0.0.1'::inet",
	"'(1,2)'::point",
	"B'1'",
	"'a'::tsvector",
	"'0/0'::pg_lsn",
	"'[1,2)'::int4range",
	"'[1.5,2)'::numrange",
	"'{1.5}'::numeric[]",
	"'{2024-01-01}'::timestamptz[]",
]

/** What keyTextsSQL carries for `value` sorted on its own, as read or not */
async function carried(client: pg.Client, value: string, asRead: boolean): Promise<string | undefined> {
	const keys = [{ column: sql`${sql.raw(`(${value})`)}`, direction: "asc" as const }]
	const query = new PgDialect().sqlToQuery(keyTextsSQL(keys, "postgres", () => asRead))
	const { rows } = await client.query<{ t: string }>(`select ${query.sql} as t`, query.params)
	return rows[0]?.t
}

describe("keyTextsSQL carries a key's text on the server only for a numeric and, as read, a time (B2-8 of area B; sibling: AB1's unit pin)", () => {
	const sessions = usePg()

	/** The built-in numeric category's base types, each by a value its input reads */
	async function numericCategory(): Promise<string[]> {
		const { rows } = await sessions
			.pg()
			.query<{ name: string }>(
				"select oid::regtype::text as name from pg_type where typcategory = 'N' and typtype = 'b' and oid < 16384",
			)
		return rows.map(({ name }) => `'1'::${name}`)
	}

	it.each([true, false])("carries text only where a list needs it, as read: %s", async (asRead) => {
		for (const statement of MADE) await sessions.pg().query(statement)
		const numbers = (await numericCategory()).filter((value) => value !== "'1'::numeric")
		expect(numbers).toEqual(expect.arrayContaining(["'1'::integer", "'1'::bigint", "'1'::money", "'1'::oid"]))
		for (const value of ROUNDED) expect(await carried(sessions.pg(), value, asRead), value).toBe("1.5")
		for (const value of TIMES) expect((await carried(sessions.pg(), value, asRead)) !== "", value).toBe(asRead)
		for (const value of [...NEVER, ...numbers]) expect(await carried(sessions.pg(), value, asRead), value).toBe("")
	})
})
