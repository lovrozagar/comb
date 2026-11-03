/**
 * CD5 and CD6 of r22b: a Postgres type modifier binds the write DTO as it binds the column. Each
 * column is built with drizzle and created from its own `getSQLType()`, so every modifier form
 * drizzle emits is the one tested. Postgres is the oracle twice over: whether it takes a value, and
 * whether it keeps it, which is whether the modified column holds what its plain base type holds for
 * the same input (a `time(0)` rounds a fraction, an `interval day` drops the time part, a
 * `numeric(3, -2)` rounds to hundreds, each without an error). The DTO never takes a value Postgres
 * would refuse or change; it refuses one Postgres keeps only for a spelling an Upgrading note lists.
 */
import { interval, numeric, pgTable, text, time, timestamp } from "drizzle-orm/pg-core"
import { getTableConfig } from "drizzle-orm/pg-core"
import type pg from "pg"
import type * as z from "zod"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { cleanGeneratedDtos, generatedDtos } from "../support/dtos.ts"
import { usePg } from "../support/pg.ts"

afterAll(() => cleanGeneratedDtos())

/* each column as the tables module declares it: the same source builds the DDL and the DTO */
const COLUMNS: Record<string, string> = {
	tt3: 'time("tt3", { withTimezone: true, precision: 3 })',
	tt0: 'time("tt0", { withTimezone: true, precision: 0 })',
	t0: 'time("t0", { precision: 0 })',
	t3: 'time("t3", { precision: 3 })',
	ts0: 'timestamp("ts0", { mode: "string", precision: 0 })',
	ts3: 'timestamp("ts3", { mode: "string", precision: 3 })',
	tz3: 'timestamp("tz3", { mode: "string", precision: 3, withTimezone: true })',
	n52: 'numeric("n52", { precision: 5, scale: 2 })',
	ns: 'numeric("ns", { precision: 2, scale: 5 })',
	nneg: 'numeric("nneg", { precision: 3, scale: -2 })',
	ivy: 'interval("ivy", { fields: "year" })',
	ivm: 'interval("ivm", { fields: "month" })',
	ivym: 'interval("ivym", { fields: "year to month" })',
	ivd: 'interval("ivd", { fields: "day" })',
	ivh: 'interval("ivh", { fields: "hour" })',
	ivhm: 'interval("ivhm", { fields: "hour to minute" })',
	ivmi: 'interval("ivmi", { fields: "minute" })',
	ivs: 'interval("ivs", { fields: "second" })',
	ivds3: 'interval("ivds3", { fields: "day to second", precision: 3 })',
	iv3: 'interval("iv3", { precision: 3 })',
}

/* the type a modifier narrows, which takes any value of its kind as written */
const BASE: Record<string, string> = {
	interval: "interval",
	numeric: "numeric",
	time: "time",
	"time with time zone": "timetz",
	timestamp: "timestamp",
	"timestamp with time zone": "timestamptz",
}

const SCOPE = { interval, numeric, pgTable, text, time, timestamp }

/** Each column's SQL type, as drizzle writes it, and its base */
function sqlTypes(): Array<{ base: string; name: string; type: string }> {
	const table = new Function(
		...Object.keys(SCOPE),
		`return pgTable("typmods", { id: text("id").primaryKey(), ${Object.entries(COLUMNS)
			.map(([key, source]) => `${key}: ${source}`)
			.join(", ")} })`,
	)(...Object.values(SCOPE))
	return getTableConfig(table)
		.columns.filter(({ name }) => name !== "id")
		.map((column) => {
			const type = column.getSQLType()
			const plain = type.replaceAll(/ ?\([^)]*\)/g, "").replace(/^interval .*/, "interval")
			return { base: BASE[plain] as string, name: column.name, type }
		})
}

/** [column, value, whether the write DTO takes it, whether Postgres keeps it as its base type would] */
type Case = [column: string, value: string, dto: boolean, kept: boolean]

const CASES: Case[] = [
	/* CD5: time(p) with time zone takes an offset, as timetz does */
	["tt3", "10:00:00+02", true, true],
	["tt3", "10:00:00Z", true, true],
	["tt3", "10:00:00.123+02:00", true, true],
	["tt3", "10:00:00.1234+02:00", false, false],
	/* stricter than Postgres, as for timetz since 0.14: a local time's offset is the session's */
	["tt3", "10:00:00", false, true],
	["tt0", "10:00:00.5+02", false, false],
	["tt0", "10:00:59+02", true, true],
	/* CD6: a precision refuses a longer fraction, which Postgres rounds */
	["t0", "23:59:59", true, true],
	["t0", "10:00", true, true],
	["t0", "23:59:59.6", false, false],
	["t3", "10:00:00.123", true, true],
	["t3", "10:00:00.1234", false, false],
	["ts0", "2024-01-01T23:59:59", true, true],
	["ts0", "2024-01-01T23:59:59.6", false, false],
	["ts3", "2024-01-01T10:00:00.123", true, true],
	["ts3", "2024-01-01T10:00:00.1234", false, false],
	["tz3", "2024-01-01T10:00:00.123+02:00", true, true],
	["tz3", "2024-01-01T10:00:00Z", true, true],
	["tz3", "2024-01-01T10:00:00.1234Z", false, false],
	/* sibling: numeric's scale bound, which refused a longer fraction before CD5 */
	["n52", "1.23", true, true],
	["n52", "1.234", false, false],
	/* CD5: numeric(p, s) with s > p: below 10^(p - s), at most s digits after the point */
	["ns", "0.00012", true, true],
	["ns", "0.00099", true, true],
	["ns", "-0.00012", true, true],
	["ns", "0", true, true],
	["ns", "0.0001", true, true],
	["ns", "0.001", false, false],
	["ns", "0.000123", false, false],
	["ns", "1", false, false],
	/* CD5: numeric(p, s) with s < 0: a whole number below 10^(p - s), its last -s digits zero */
	["nneg", "99900", true, true],
	["nneg", "100", true, true],
	["nneg", "0", true, true],
	["nneg", "-500", true, true],
	["nneg", "123456", false, false],
	["nneg", "99949", false, false],
	["nneg", "150", false, false],
	["nneg", "1.5", false, false],
	/* CD6: an interval's fields refuse a component below the last field, which Postgres drops */
	["ivy", "P2Y", true, true],
	["ivy", "P1Y2M", false, false],
	["ivm", "P1Y2M", true, true],
	["ivm", "P1Y2M3D", false, false],
	["ivym", "P1Y2M", true, true],
	["ivym", "P1Y2M3D", false, false],
	["ivym", "P1W", false, false],
	["ivd", "P1D", true, true],
	["ivd", "P1W", true, true],
	["ivd", "P1Y2M3D", true, true],
	["ivd", "PT1H", false, false],
	["ivd", "P1DT23H59M", false, false],
	["ivh", "P1DT5H", true, true],
	["ivh", "PT5H1M", false, false],
	["ivhm", "PT1H30M", true, true],
	["ivhm", "P1DT1H", true, true],
	["ivhm", "PT1H30M5S", false, false],
	["ivmi", "PT5M", true, true],
	["ivmi", "PT5M1S", false, false],
	["ivs", "P1DT1.5S", true, true],
	/* CD6: an interval's precision refuses a longer fraction of a second */
	["ivds3", "PT1.123S", true, true],
	["ivds3", "P1DT1S", true, true],
	["ivds3", "PT1.1234S", false, false],
	["iv3", "PT1.123S", true, true],
	["iv3", "P1Y", true, true],
	["iv3", "PT1.1234S", false, false],
]

/** Whether Postgres takes `value` into `column`, and holds what the column's plain base type holds for it */
async function kept(client: pg.Client, column: string, value: string): Promise<boolean> {
	await client.query("SAVEPOINT probe")
	try {
		await client.query(`INSERT INTO typmods (id, ${column}, ${column}_plain) VALUES ('k', $1, $1)`, [value])
		const { rows } = await client.query(`SELECT ${column} = ${column}_plain AS same FROM typmods`)
		await client.query("ROLLBACK TO SAVEPOINT probe")
		return rows[0].same === true
	} catch {
		// reason: the probe asks whether Postgres refuses the value; a refusal is the answer, not a failure
		await client.query("ROLLBACK TO SAVEPOINT probe")
		return false
	}
}

describe("a Postgres type modifier is parsed once (CD5, CD6; sibling: numeric's scale bound)", () => {
	const sessions = usePg()
	let create: z.ZodObject

	beforeAll(async () => {
		const dtos = await generatedDtos(
			"cd5",
			`import { interval, numeric, text, time, timestamp } from "drizzle-orm/pg-core"\nexport const typmods = pgTable("typmods", { id: text("id").primaryKey(), ${Object.entries(
				COLUMNS,
			)
				.map(([key, source]) => `${key}: ${source}`)
				.join(", ")} })`,
			{ dialect: "postgres" },
		)
		create = dtos["typmods"]?.["typmodsDtoCreateSchema"] as z.ZodObject
	})

	beforeEach(async () => {
		const columns = sqlTypes().flatMap(({ base, name, type }) => [`${name} ${type}`, `${name}_plain ${base}`])
		await sessions.pg().query(`CREATE TEMP TABLE typmods (id text PRIMARY KEY, ${columns.join(", ")})`)
		await sessions.pg().query("BEGIN")
	})

	it("creates each column from the type drizzle writes, every modifier form among them", () => {
		expect(sqlTypes().map(({ type }) => type)).toEqual([
			"time(3) with time zone",
			"time(0) with time zone",
			"time(0)",
			"time(3)",
			"timestamp(0)",
			"timestamp(3)",
			"timestamp(3) with time zone",
			"numeric(5, 2)",
			"numeric(2, 5)",
			"numeric(3, -2)",
			"interval year",
			"interval month",
			"interval year to month",
			"interval day",
			"interval hour",
			"interval hour to minute",
			"interval minute",
			"interval second",
			"interval day to second(3)",
			"interval(3)",
		])
	})

	it.each(CASES)("%s %j: the DTO takes it %s, Postgres keeps it %s", async (...[column, value, dto, pg]: Case) => {
		expect(await kept(sessions.pg(), column, value)).toBe(pg)
		expect(create.safeParse({ id: "k", [column]: value }).success).toBe(dto)
	})

	it("takes no value Postgres would refuse or change", () => {
		expect(CASES.filter(([, , dto, pg]) => dto && !pg)).toEqual([])
	})
})
