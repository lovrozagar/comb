import { fixtureRoot } from "../__fixtures__/temp.ts"
import fs from "node:fs"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { analyze } from "../analyzer.ts"
import { validateTables as validateAnalysis } from "./validate.ts"

/** The validation of the tables file `file`, read at runtime as codegen reads it */
const validateTables = (file: string) => validateAnalysis(analyze(file))

let dir: string

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(fixtureRoot(), "comb-validate-machines-"))
})

afterEach(() => fs.rmSync(dir, { force: true, recursive: true }))

/** Writes `source` under the sqlite and columns imports into a fresh tables file and validates it. */
function validate(source: string) {
	const file = path.join(dir, "db.test.tables.ts")
	fs.writeFileSync(
		file,
		`import { sqliteTable } from "drizzle-orm/sqlite-core"\nimport { c } from "@lovrozagar/comb/sqlite/columns"\n${source}`,
	)
	return validateTables(file)
}

describe("validateTables: state machines in every form the docs allow (M-M5, M-M7)", () => {
	it("catches a typo in a machine whose values are as const", () => {
		const result = validate(`export const t = sqliteTable("t", {
	id: c.id("ttt"),
	status: c.enum("status", ["queued", "sent"] as const, { initial: "queued", terminal: ["dotypo"] }),
})`)
		expect(result.errors).toEqual(['t.status: terminal names "dotypo", which is not a declared value'])
	})

	it("catches a typo in a machine held as a const (state-machines §4)", () => {
		const result = validate(`const deliveryStates = {
	values: ["queued", "sending", "sent"],
	initial: "queued",
	terminal: ["sent"],
	transitions: { queued: ["sending"], sendng: ["sent"] },
} as const
export const t = sqliteTable("t", { id: c.id("ttt"), status: c.enum("status", deliveryStates.values, deliveryStates) })`)
		expect(result.errors).toEqual(['t.status: transitions names "sendng", which is not a declared value'])
	})

	it("accepts dotted state names", () => {
		const result = validate(`export const t = sqliteTable("t", {
	id: c.id("ttt"),
	status: c.enum("status", ["open", "payment.failed"], { initial: "open", terminal: ["payment.failed"], transitions: { open: ["payment.failed"] } }),
})`)
		expect(result).toEqual({ errors: [], warnings: [] })
	})

	it("validates tables declared with pgTable", () => {
		const file = path.join(dir, "db.pg.tables.ts")
		fs.writeFileSync(
			file,
			`import { pgTable, text } from "drizzle-orm/pg-core"\nexport const a = pgTable("a", { id: text("id").primaryKey(), id2: text("id2").references(() => a.id) })`,
		)
		expect(validateTables(file)).toEqual({ errors: [], warnings: [] })
	})
})

describe("validateTables: state machines without a full map, and dead ends", () => {
	it("checks a machine without a terminal list or an initial state", () => {
		const onlyInitial = validate(
			`export const t = sqliteTable("t", { id: c.id("ttt"), status: c.enum("status", ["a", "b"], { initial: "zz" }) })`,
		)
		expect(onlyInitial.errors).toEqual(['t.status: initial names "zz", which is not a declared value'])
		const full = validate(
			`export const t = sqliteTable("t", { id: c.id("ttt"), status: c.enum("status", ["a", "b"], { transitions: { a: ["b"], b: ["a"] } }) })`,
		)
		expect(full).toEqual({ errors: [], warnings: [] })
	})

	it("warns, rather than rejects, a dead end in a partial map", () => {
		const result = validate(
			`export const t = sqliteTable("t", { id: c.id("ttt"), status: c.enum("status", ["a", "b", "c"], { terminal: ["c"], transitions: { a: [] } }) })`,
		)
		expect(result).toEqual({ errors: [], warnings: ['t.status: "a" has no outgoing transitions and is not terminal'] })
	})

	it("rejects a dead end in a map declared in full", () => {
		const result = validate(
			`export const t = sqliteTable("t", { id: c.id("ttt"), status: c.enum("status", ["a", "b", "c"], { initial: "a", terminal: ["c"], transitions: { a: ["b", "c"], b: [] } }) })`,
		)
		expect(result.errors).toEqual(['t.status: "b" has no outgoing transitions and is not terminal'])
	})
})
