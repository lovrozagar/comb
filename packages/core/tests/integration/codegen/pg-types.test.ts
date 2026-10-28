/**
 * F50 of the 0.13.0 round: a plain Postgres column's write DTO takes what Postgres takes for its
 * data type, so a value the database would refuse is a 400 from the DTO, not a 22P02 from the
 * insert. Each case says whether the DTO takes it and whether Postgres does, and both are checked:
 * the DTO never takes what Postgres refuses, and refuses what Postgres takes only for a spelling
 * the 0.14 changelog lists. A read DTO keeps the plain type, as a read never refuses a stored row.
 */
import type pg from "pg"
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
	n52: numeric("n52", { precision: 5, scale: 2 }),
	n3: numeric("n3", { precision: 3 }),
	nn: numeric("nn"),
	nr: numeric("nr", { mode: "number", precision: 5, scale: 2 }),
	b: bigint("b", { mode: "string" }),
	r: real("r"),
	ip: inet("ip"),
	net: cidr("net"),
}`
const DDL =
	"CREATE TEMP TABLE kinds (id text PRIMARY KEY, d date, ts timestamp, tz timestamptz, t time, tt timetz, n52 numeric(5,2), n3 numeric(3), nn numeric, nr numeric(5,2), b bigint, r real, ip inet, net cidr)"

/** [column, value, whether the write DTO takes it, whether Postgres does] */
type Case = [column: string, value: number | string, dto: boolean, pg: boolean]

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
	["n52", "123.45", true, true],
	["n52", "-999.99", true, true],
	["n52", "0012.5", true, true],
	["n52", "1234.5", false, false],
	/* Postgres rounds the fraction first, and 999.995 rounds to 1000.00, past numeric(5,2): a 22003 */
	["n52", "999.995", false, false],
	["n52", "abc", false, false],
	/* stricter than Postgres, listed in the 0.14 changelog: a fraction it would round, an exponent, NaN */
	["n52", "1.234", false, true],
	["n52", "1e2", false, true],
	["n52", "NaN", false, true],
	["n3", "999", true, true],
	["n3", "1000", false, false],
	["n3", "1.5", false, true],
	["nn", "123456789012345678901234567890.123", true, true],
	["nn", "-0.5", true, true],
	["nn", "1.5e3", false, true],
	["nr", 999.99, true, true],
	["nr", -999.994, true, true],
	["nr", 999.995, false, false],
	["nr", 1000, false, false],
	["b", "9223372036854775807", true, true],
	["b", "-9223372036854775808", true, true],
	["b", "9223372036854775808", false, false],
	["b", "-9223372036854775809", false, false],
	["b", "12.5", false, false],
	["r", 3.4028235e38, true, true],
	["r", -3.4028235e38, true, true],
	["r", 3.5e38, false, false],
	["r", 0, true, true],
	/* real refuses what rounds to zero: at or below half the smallest float4, 2^-150 */
	["r", 1e-50, false, false],
	["r", 7.006492321624085e-46, false, false],
	["r", 7.006492321624087e-46, true, true],
	["r", 1e-45, true, true],
	["r", -1e-45, true, true],
	["ip", "192.168.0.1", true, true],
	["ip", "192.168.0.1/24", true, true],
	["ip", "::1", true, true],
	["ip", "fe80::1/64", true, true],
	["ip", "300.1.1.1", false, false],
	["ip", "localhost", false, false],
	["net", "192.168.0.0/24", true, true],
	["net", "10.0.0.0/8", true, true],
	["net", "192.168.0.1", true, true],
	["net", "2001:db8::/32", true, true],
	["net", "fe80::/64", true, true],
	["net", "::ffff:192.168.0.0/120", true, true],
	/* a cidr has no bits set right of its mask: Postgres refuses each of these */
	["net", "192.168.0.1/24", false, false],
	["net", "10.0.0.1/8", false, false],
	["net", "fe80::1/64", false, false],
	["net", "2001:db8::1/32", false, false],
	["net", "192.168.0.0/33", false, false],
	/* stricter than Postgres, listed in the 0.14 changelog: an abbreviated network */
	["net", "10.1", false, true],
]

/** Whether Postgres stores `value` in `column` */
async function stored(client: pg.Client, [column, value]: [string, number | string]): Promise<boolean> {
	try {
		await client.query(`INSERT INTO kinds (id, ${column}) VALUES ('k', $1)`, [value])
		return true
	} catch {
		// reason: the probe asks whether Postgres refuses the value; a refusal is the answer, not a failure
		return false
	}
}

/** The kinds table's generated create and read DTOs */
async function kindsDtos(): Promise<{ create: z.ZodObject; read: z.ZodObject }> {
	const dtos = await generatedDtos(
		"f50",
		`import { bigint, cidr, date, inet, numeric, real, text, time, timestamp } from "drizzle-orm/pg-core"\nexport const kinds = pgTable("kinds", ${COLUMNS})`,
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

	it.each(CASES)("%s %j: the DTO takes it %s, Postgres %s", async (...[column, value, dto, pg]: Case) => {
		expect(create.safeParse({ id: "k", [column]: value }).success).toBe(dto)
		expect(await stored(sessions.pg(), [column, value])).toBe(pg)
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
			.query(
				"INSERT INTO kinds VALUES ('k', 'infinity', 'infinity', '-infinity', '24:00', '24:00+00', 'NaN', 7, 'Infinity', 1.5, 1, 1e-45)",
			)
		/* as text, as drizzle's string mode reads each of them */
		const { rows } = await sessions
			.pg()
			.query(
				"SELECT id, d::text AS d, ts::text AS ts, tz::text AS tz, t::text AS t, tt::text AS tt, n52::text AS n52, n3::text AS n3, nn::text AS nn, nr::float8 AS nr, b::text AS b, r, ip::text AS ip, net::text AS net FROM kinds",
			)
		expect(read.safeParse(rows[0]).success).toBe(true)
	})
})
