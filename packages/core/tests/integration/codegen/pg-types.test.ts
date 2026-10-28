/**
 * F50 of the 0.13.0 round: a plain Postgres column's write DTO takes what Postgres takes for its
 * data type, so a value the database would refuse is a 400 from the DTO, not a 22P02 from the
 * insert. Each case says whether the DTO takes it and whether Postgres does, and both are checked:
 * the DTO never takes what Postgres refuses, and refuses what Postgres takes only for a spelling
 * the 0.14 changelog lists. A read DTO keeps the plain type, as a read never refuses a stored row.
 */
import type * as z from "zod"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { cleanGeneratedDtos, generatedDtos } from "../support/dtos.ts"
import { usePg } from "../support/pg.ts"

afterAll(() => cleanGeneratedDtos())

/* each column nullable, so a body of the key and one column says that column's verdict */
const COLUMNS = `{
	id: text("id").primaryKey(),
	d: date("d"),
	ts: timestamp("ts", { mode: "string" }),
	tz: timestamp("tz", { mode: "string", withTimezone: true }),
	t: time("t"),
	tt: time("tt", { withTimezone: true }),
}`
const DDL = "CREATE TEMP TABLE kinds (id text PRIMARY KEY, d date, ts timestamp, tz timestamptz, t time, tt timetz)"

/** [column, value, whether the write DTO takes it, whether Postgres does] */
type Case = [column: string, value: string, dto: boolean, pg: boolean]

const CASES: Case[] = [
	["d", "2024-02-29", true, true],
	["d", "2024-02-30", false, false],
	/* stricter than Postgres, listed in the 0.14 changelog: its special inputs, and a year past 9999 */
	["d", "tomorrow", false, true],
	["d", "10000-01-01", false, true],
	["ts", "2024-01-01T10:00:00", true, true],
	["ts", "2024-01-01T10:00:00.123456", true, true],
	["ts", "2024-13-01T10:00:00", false, false],
	["ts", "soon", false, false],
	/* stricter than Postgres, listed in the 0.14 changelog: a timestamp discards an offset or Z */
	["ts", "2024-01-01T10:00:00+05:00", false, true],
	["ts", "2024-01-01T10:00:00Z", false, true],
	["tz", "2024-01-01T10:00:00+02:00", true, true],
	["tz", "2024-01-01T10:00:00.1234567Z", true, true],
	["tz", "2024-01-01T25:00:00Z", false, false],
	/* stricter than Postgres, listed in the 0.14 changelog: a local time's instant depends on the session's TimeZone */
	["tz", "2024-01-01T10:00:00", false, true],
	["t", "10:00", true, true],
	["t", "23:59:59.999999", true, true],
	["t", "25:00", false, false],
	/* stricter than Postgres, listed in the 0.14 changelog */
	["t", "24:00:00", false, true],
	["tt", "10:00:00+02", true, true],
	["tt", "10:00Z", true, true],
	["tt", "10:00:00+02:30", true, true],
	["tt", "10:61:00+02", false, false],
]

/** The kinds table's generated create and read DTOs */
async function kindsDtos(): Promise<{ create: z.ZodObject; read: z.ZodObject }> {
	const dtos = await generatedDtos(
		"f50",
		`import { date, text, time, timestamp } from "drizzle-orm/pg-core"\nexport const kinds = pgTable("kinds", ${COLUMNS})`,
		{ dialect: "postgres" },
	)
	return {
		create: dtos["kinds"]?.["kindsDtoCreateSchema"] as z.ZodObject,
		read: dtos["kinds"]?.["kindsDtoReadSchema"] as z.ZodObject,
	}
}

describe("a plain Postgres column's write DTO, by its data type (F50)", () => {
	const sessions = usePg()
	let create: z.ZodObject
	let read: z.ZodObject

	beforeAll(async () => {
		;({ create, read } = await kindsDtos())
	})

	beforeEach(async () => {
		await sessions.pg().query(DDL)
	})

	/** Whether Postgres stores `value` in `column` */
	const stored = async (column: string, value: string) => {
		try {
			await sessions.pg().query(`INSERT INTO kinds (id, ${column}) VALUES ('k', $1)`, [value])
			return true
		} catch {
			// reason: the probe asks whether Postgres refuses the value; a refusal is the answer, not a failure
			return false
		}
	}

	it.each(CASES)("%s %j: the DTO takes it %s, Postgres %s", async (...[column, value, dto, pg]: Case) => {
		expect(create.safeParse({ id: "k", [column]: value }).success).toBe(dto)
		expect(await stored(column, value)).toBe(pg)
	})

	/* why each refuses what Postgres takes: the instant a timestamp or a session zone would lose */
	it("keeps the instant of each kind's accepted form, where the refused one loses it", async () => {
		const client = sessions.pg()
		const local = "2024-01-01T10:00:00"
		const instant = "2024-01-01T10:00:00+05:00"
		expect(create.safeParse({ id: "a", ts: local, tz: instant }).success).toBe(true)
		await client.query("INSERT INTO kinds (id, ts, tz) VALUES ('a', $1, $2)", [local, instant])
		await client.query("INSERT INTO kinds (id, ts) VALUES ('b', $1)", [instant])
		const at = async (id: string) =>
			(await client.query("SELECT ts::text AS ts, (tz AT TIME ZONE 'UTC')::text AS tz FROM kinds WHERE id = $1", [id]))
				.rows[0]
		expect(await at("a")).toEqual({ ts: "2024-01-01 10:00:00", tz: "2024-01-01 05:00:00" })
		/* the +05:00 is gone: the stored timestamp names 10:00 in no zone, not 05:00 UTC */
		expect(await at("b")).toMatchObject({ ts: "2024-01-01 10:00:00" })
		await client.query("SET TIME ZONE 'Asia/Kathmandu'")
		await client.query("INSERT INTO kinds (id, tz) VALUES ('c', $1)", [local])
		expect(await at("c")).toMatchObject({ tz: "2024-01-01 04:15:00" })
	})

	it("reads back whatever Postgres stores, its infinities and its own spellings included", async () => {
		await sessions
			.pg()
			.query("INSERT INTO kinds VALUES ('k', 'infinity', 'infinity', '-infinity', '24:00', '24:00+00')")
		/* as text, as drizzle's string mode reads each of them */
		const { rows } = await sessions
			.pg()
			.query("SELECT id, d::text AS d, ts::text AS ts, tz::text AS tz, t::text AS t, tt::text AS tt FROM kinds")
		expect(read.safeParse(rows[0]).success).toBe(true)
	})
})
