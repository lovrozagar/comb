/** The constraint map's keys and verdicts, built from analyzed tables on each dialect */
import fs from "node:fs"
import os from "node:os"
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
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-constraint-map-"))
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
