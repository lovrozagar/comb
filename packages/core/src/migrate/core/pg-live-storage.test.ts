/**
 * PA17 of r22b, 16.3 (c) of plan 21: where the target keeps its relations, read from its catalog for
 * a pending move (pg-live-storage.ts). check-storage.test.ts runs the read on Postgres; this holds
 * how its rows key under the target's schema, a target without the postgres package, and a read that
 * fails, with its password masked.
 */
import { beforeAll, describe, expect, it } from "vitest"
import { movesStorage, placedOf, readPlaced } from "./pg-live-storage.ts"
import { loadPostgresParser, parsePostgres } from "./pg-parser.ts"

/** A postgres.js answering the query with `rows`, or failing it with `fails`, recording what it saw */
function fakeConnect(rows: Array<Record<string, unknown>>, fails?: Error) {
	const seen = { ended: false, urls: [] as unknown[] }
	const connect = (options: Record<string, unknown>) => {
		seen.urls.push(options["database"])
		return {
			end: async () => void (seen.ended = true),
			unsafe: async () => {
				if (fails !== undefined) throw fails
				return rows
			},
		}
	}
	return { load: async () => connect, seen }
}

const target = { schema: "app", url: "postgres://app:App-Secret-0451@localhost/target" }

const ROWS = [
	{ kind: "r", method: "heap", name: "t", persistence: "p", schema: "app", tablespace: "pg_default" },
	{ kind: "m", method: "heap", name: "mv", persistence: "u", schema: "other", tablespace: "fast" },
	{ kind: "i", method: "btree", name: "t_id", persistence: "p", schema: "app", tablespace: "pg_default" },
]

const PLACED = {
	indexes: new Map([["t_id", "pg_default"]]),
	relations: new Map([
		["t", { accessMethod: "heap", logged: true, tablespace: "pg_default" }],
		["other.mv", { accessMethod: "heap", logged: false, tablespace: "fast" }],
	]),
}

describe("readPlaced", () => {
	it("keys each relation under the target's schema, as the history's facts are, and closes the connection", async () => {
		const { load, seen } = fakeConnect(ROWS)
		expect(await readPlaced(target, load)).toEqual(PLACED)
		expect(seen).toEqual({ ended: true, urls: ["target"] })
		expect(placedOf(ROWS, "other").relations.has("app.t")).toBe(true)
	})

	it("reads nothing without the postgres package, so each move it cannot place warns", async () => {
		expect(await readPlaced(target, () => Promise.reject(new Error("no postgres")))).toBeUndefined()
	})

	it("refuses, the password masked, when the read fails", async () => {
		const { load, seen } = fakeConnect([], new Error("password authentication failed for App-Secret-0451"))
		const refused = readPlaced(target, load)
		await expect(refused).rejects.toThrow(/^comb could not read where url keeps its relations: password authentication/)
		await expect(refused).rejects.not.toThrow("App-Secret-0451")
		expect(seen.ended).toBe(true)
	})
})

describe("movesStorage", () => {
	beforeAll(loadPostgresParser)

	it.each([
		["ALTER TABLE t SET ACCESS METHOD heap", true],
		["ALTER MATERIALIZED VIEW mv SET TABLESPACE fast", true],
		["ALTER INDEX i SET TABLESPACE fast", true],
		["ALTER TABLE t SET LOGGED", false],
		["ALTER TABLE t ADD COLUMN c int", false],
	])("reads %j as a move the target's catalog places: %s", (sql, moves) => {
		expect(movesStorage([parsePostgres(sql).stmts, undefined])).toBe(moves)
	})
})
