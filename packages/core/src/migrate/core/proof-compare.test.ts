import { afterEach, describe, expect, it } from "vitest"
import { type MemoryDb, openMemory } from "../drivers/memory.ts"
import { compare, type Shape } from "./proof-compare.ts"

const open: MemoryDb[] = []
afterEach(() => {
	for (const db of open.splice(0)) db.close()
})

/** A table shape: `columns`, each nullable unless listed in `notNull`, with `defaults` and `rows` (values as SQLite quotes them) */
const shape = (
	columns: string[],
	rows: string[][],
	{ defaults = {}, notNull = [] }: { defaults?: Record<string, string>; notNull?: string[] } = {},
): Shape => ({
	columns,
	defaults: new Map(columns.map((column) => [column, defaults[column] ?? null])),
	nullable: new Set(columns.filter((column) => !notNull.includes(column))),
	rows,
})

/** An in-memory database, closed after the test: allowedDefaults quotes a default through it */
async function memory() {
	const opened = await openMemory()
	open.push(opened)
	return opened
}

describe("compare", () => {
	it("finds nothing when every row and column is kept", async () => {
		const t = shape(["id", "a"], [["1", "'x'"]])
		expect(compare(await memory(), new Map([["t", t]]), new Map([["t", t]]))).toEqual({ cautious: [], unsafe: [] })
	})

	it("names a lost table, a lost column, lost rows and a changed value", async () => {
		const was = shape(
			["id", "a", "b"],
			[
				["1", "'x'", "2"],
				["2", "'y'", "3"],
			],
		)
		const db = await memory()
		expect(compare(db, new Map([["t", was]]), new Map())).toEqual({
			cautious: [],
			unsafe: ["loses every row of t"],
		})
		expect(
			compare(
				db,
				new Map([["t", was]]),
				new Map([
					[
						"t",
						shape(
							["id", "a"],
							was.rows.map((row) => row.slice(0, 2)),
						),
					],
				]),
			).unsafe,
		).toEqual(["loses t.b"])
		expect(
			compare(db, new Map([["t", was]]), new Map([["t", shape(was.columns, [was.rows[0] as string[]])]])).unsafe,
		).toEqual(["loses 1 of the 2 rows of t"])
		expect(
			compare(
				db,
				new Map([["t", was]]),
				new Map([
					[
						"t",
						shape(was.columns, [
							["1", "'x'", "2"],
							["2", "'z'", "3"],
						]),
					],
				]),
			).unsafe,
		).toEqual(["changes values of t.a"])
	})
})

describe("compare: the NULL allowance and moved values", () => {
	it("calls a NULL that lands as the new DEFAULT of a column made NOT NULL cautious", async () => {
		const was = shape(
			["id", "tier"],
			[
				["1", "NULL"],
				["2", "'pro'"],
			],
		)
		const now = shape(
			["id", "tier"],
			[
				["1", "''"],
				["2", "'pro'"],
			],
			{ defaults: { tier: "''" }, notNull: ["tier"] },
		)
		expect(compare(await memory(), new Map([["t", was]]), new Map([["t", now]]))).toEqual({
			cautious: ["fills t.tier's NULLs with its default"],
			unsafe: [],
		})
	})

	it("names each column whose values moved between rows", async () => {
		const was = shape(
			["a", "b"],
			[
				["1", "2"],
				["3", "4"],
			],
		)
		const now = shape(
			["a", "b"],
			[
				["1", "4"],
				["3", "2"],
			],
		)
		expect(compare(await memory(), new Map([["t", was]]), new Map([["t", now]])).unsafe).toEqual([
			"changes values of t.a",
			"changes values of t.b",
		])
	})
})

/* M22 of the 0.12 round: a rename keeps every value, so the proof says so, still unsafe, rather than call it a loss */
describe("compare: renames", () => {
	const users = shape(
		["id", "email"],
		[
			["1", "'a@x'"],
			["2", "'b@x'"],
		],
	)

	it("names a column whose values a new column holds row for row as renamed", async () => {
		const renamed = shape(["id", "mail"], users.rows)
		expect(compare(await memory(), new Map([["users", users]]), new Map([["users", renamed]])).unsafe).toEqual([
			"renames users.email to users.mail",
		])
	})

	it("calls a column lost when the new column's values do not follow its rows", async () => {
		const shuffled = shape(
			["id", "mail"],
			[
				["1", "'b@x'"],
				["2", "'a@x'"],
			],
		)
		expect(compare(await memory(), new Map([["users", users]]), new Map([["users", shuffled]])).unsafe).toEqual([
			"loses users.email",
		])
	})

	it("gives each new column to one lost column only", async () => {
		const twins = shape(["id", "a", "b"], [["1", "'v'", "'v'"]])
		const one = shape(["id", "c"], [["1", "'v'"]])
		expect(compare(await memory(), new Map([["t", twins]]), new Map([["t", one]])).unsafe).toEqual([
			"renames t.a to t.c",
			"loses t.b",
		])
	})

	it("names a table whose rows a new table holds as renamed, and a table with other rows as lost", async () => {
		const db = await memory()
		expect(compare(db, new Map([["users", users]]), new Map([["accounts", users]])).unsafe).toEqual([
			"renames users to accounts",
		])
		const other = shape(users.columns, [users.rows[0] as string[]])
		expect(compare(db, new Map([["users", users]]), new Map([["accounts", other]])).unsafe).toEqual([
			"loses every row of users",
		])
	})
})
