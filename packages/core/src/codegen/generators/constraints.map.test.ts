import { fixtureRoot } from "../__fixtures__/temp.ts"
/** The constraint map's keys and verdicts, built from analyzed tables on each dialect */
import fs from "node:fs"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { analyze } from "../analyzer.ts"
import { buildConstraintMap } from "./constraints.ts"

const made: string[] = []
afterEach(() => {
	for (const dir of made.splice(0)) fs.rmSync(dir, { force: true, recursive: true })
})

/** The tables of `source`, analyzed */
function tablesOf(source: string) {
	const dir = fs.mkdtempSync(path.join(fixtureRoot(), "comb-constraint-map-"))
	made.push(dir)
	const file = path.join(dir, "db.test.tables.ts")
	fs.writeFileSync(file, source)
	return analyze(file).tables
}

const SQLITE = `import { sql } from "drizzle-orm"
import { check, sqliteTable, text, integer } from "drizzle-orm/sqlite-core"
`
const PG = `import { sql } from "drizzle-orm"
import { check, pgTable, text, integer } from "drizzle-orm/pg-core"
`

describe("buildConstraintMap: error keys two constraints would share (F20)", () => {
	it("fails codegen naming both constraints", () => {
		const tables =
			tablesOf(`${SQLITE}export const user = sqliteTable("user", { id: text("id").primaryKey(), email_address: text("email_address").unique() })
export const user_email = sqliteTable("user_email", { id: text("id").primaryKey(), address: text("address").unique() })
`)
		expect(() => buildConstraintMap(tables)).toThrow(
			/^the error key user_email_address_duplicate names two constraints: user\.unique\.email_address and user_email\.unique\.address; rename a column/,
		)
	})
})

describe("buildConstraintMap: a CHECK name Postgres cuts (F21)", () => {
	const LONG = "organization_membership_invitation_seats_must_stay_inside_the_allowed_range"
	const source = (dialect: string) =>
		`${dialect === "postgres" ? PG : SQLITE}export const t = ${dialect === "postgres" ? "pgTable" : "sqliteTable"}("t", { id: text("id").primaryKey(), seats: integer("seats") }, (t) => [check("${LONG}", sql\`\${t.seats} < 20\`)])\n`

	it("keys it by the 63 bytes Postgres keeps of it, and by its whole name on SQLite", () => {
		const pg = buildConstraintMap(tablesOf(source("postgres")), "postgres")
		expect(Object.keys(pg["t"]?.check ?? {})).toEqual([LONG.slice(0, 63)])
		const sqlite = buildConstraintMap(tablesOf(source("sqlite")), "sqlite")
		expect(Object.keys(sqlite["t"]?.check ?? {})).toEqual([LONG])
	})

	it("fails when two CHECK names cut to one", () => {
		const twin = `${PG}export const t = pgTable("t", { id: text("id").primaryKey(), seats: integer("seats") }, (t) => [
	check("${LONG}_a", sql\`\${t.seats} < 20\`),
	check("${LONG}_b", sql\`\${t.seats} > 0\`),
])\n`
		expect(() => buildConstraintMap(tablesOf(twin), "postgres")).toThrow(
			/^t: the CHECKs .* and .* share the 63 bytes Postgres keeps of their names/,
		)
	})
})

describe("buildConstraintMap: a CHECK's verdict (F27) and comb's own enum CHECKs (F28)", () => {
	it("calls every CHECK but comb's own conventions a 400 'Check constraint violated', whatever its name holds", () => {
		const tables =
			tablesOf(`${SQLITE}export const t = sqliteTable("t", { id: text("id").primaryKey(), seats: integer("seats") }, (t) => [
	check("seats_within_valid_range", sql\`\${t.seats} < 20\`),
	check("data_integrity", sql\`\${t.seats} > 0\`),
])\n`)
		const check = buildConstraintMap(tables)["t"]?.check
		expect(check?.["seats_within_valid_range"]).toMatchObject({
			cause: "Check constraint violated",
			statusKey: "bad_request",
		})
		expect(check?.["data_integrity"]).toMatchObject({ cause: "Check constraint violated", statusKey: "bad_request" })
	})

	it("maps each enum column's CHECK under the name the enum-checks generator writes, cut on Postgres", () => {
		const column = "notificationDeliveryStatus"
		const enums = (dialect: "postgres" | "sqlite") =>
			tablesOf(
				`${dialect === "postgres" ? PG : SQLITE}import { c } from "@lovrozagar/comb/${dialect === "postgres" ? "pg" : "sqlite"}/columns"\nexport const organization_notification = ${dialect === "postgres" ? "pgTable" : "sqliteTable"}("organization_notification", { id: text("id").primaryKey(), ${column}: c.enum("${column}", ["sent", "failed"]) })\n`,
			)
		const name = `organization_notification_${column}_enum`
		expect(buildConstraintMap(enums("sqlite"))["organization_notification"]?.check?.[name]).toEqual({
			cause: "Invalid enum value",
			errorKey: `organization_notification_${column}_enum_invalid`,
			statusKey: "bad_request",
		})
		const pg = buildConstraintMap(enums("postgres"), "postgres")["organization_notification"]?.check ?? {}
		expect(Object.keys(pg)).toEqual([name.slice(0, 63)])
	})
})

describe("buildConstraintMap: a CHECK named after its table (F35)", () => {
	it("names its key once with the table, not twice", () => {
		const tables =
			tablesOf(`${SQLITE}export const invite = sqliteTable("invite", { id: text("id").primaryKey(), seats: integer("seats") }, (t) => [
	check("invite_seats_in_range", sql\`\${t.seats} < 20\`),
	check("seats_positive", sql\`\${t.seats} > 0\`),
])\n`)
		const check = buildConstraintMap(tables)["invite"]?.check
		expect(check?.["invite_seats_in_range"]?.errorKey).toBe("invite_seats_in_range_failed")
		expect(check?.["seats_positive"]?.errorKey).toBe("invite_seats_positive_failed")
	})
})

/*
 * F47 of the 0.13.0 round: a declared CHECK under comb's enum CHECK name is comb's own, applied, and
 * maps once; two CHECKs of one name blame Postgres's cut only when the cut is what joins them.
 */
describe("buildConstraintMap: comb's enum CHECK declared, and CHECKs of one name (F47)", () => {
	const ENUM = `import { c } from "@lovrozagar/comb/sqlite/columns"
export const t = sqliteTable("t", { id: text("id").primaryKey(), status: c.enum("status", ["a", "it's"]) }, (t) => [`

	it("maps comb's own enum CHECK once, as the enum's, when the table declares it", () => {
		const tables = tablesOf(`${SQLITE}${ENUM}check("t_status_enum", sql\`\${t.status} IN ('a', 'it''s')\`)])\n`)
		expect(buildConstraintMap(tables)["t"]?.check).toEqual({
			t_status_enum: expect.objectContaining({ errorKey: "t_status_enum_invalid" }),
		})
	})

	it("maps it once on Postgres too, as pg-core renders it", () => {
		const tables = tablesOf(`${PG}import { c } from "@lovrozagar/comb/pg/columns"
export const t = pgTable("t", { id: text("id").primaryKey(), status: c.enum("status", ["a", "it's"]) }, (t) => [check("t_status_enum", sql\`\${t.status} IN ('a', 'it''s')\`)])\n`)
		expect(Object.keys(buildConstraintMap(tables, "postgres")["t"]?.check ?? {})).toEqual(["t_status_enum"])
	})

	it("refuses a CHECK under comb's enum name that checks something else", () => {
		const tables = tablesOf(`${SQLITE}${ENUM}check("t_status_enum", sql\`\${t.status} IN ('a')\`)])\n`)
		expect(() => buildConstraintMap(tables)).toThrow(
			"t: the CHECK t_status_enum takes the name comb gives the enum CHECK of t.status, but checks something else; rename it",
		)
	})

	it("names two CHECKs of one name as such, on either dialect", () => {
		for (const [head, builder, dialect] of [
			[SQLITE, "sqliteTable", "sqlite"],
			[PG, "pgTable", "postgres"],
		] as const) {
			const tables =
				tablesOf(`${head}export const t = ${builder}("t", { id: text("id").primaryKey(), seats: integer("seats") }, (t) => [
	check("seats_ok", sql\`\${t.seats} < 20\`),
	check("seats_ok", sql\`\${t.seats} > 0\`),
])\n`)
			expect(() => buildConstraintMap(tables, dialect)).toThrow(/^t: two CHECKs are named seats_ok; rename one$/)
		}
	})
})
