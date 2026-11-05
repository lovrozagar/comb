/**
 * What check's replay reads of a transaction's locks at a VALIDATE (pg-replay-held.ts), against a
 * postgres.js stand-in; tests/integration/postgres/check-held.test.ts holds it to Postgres 17.
 */
import { beforeAll, describe, expect, it } from "vitest"
import { nodeOf } from "./pg-outside-transaction.ts"
import { loadPostgresParser } from "./pg-parser.ts"
import { heldBefore, heldNow, opens, validates } from "./pg-replay-held.ts"
import { pgRead } from "./pg-split.ts"

beforeAll(loadPostgresParser)

/** The type and node of `sql`'s one statement */
const parsed = (sql: string) => nodeOf(pgRead(sql).statements[0]?.tree)

/** A postgres.js stand-in: each query it was sent with its parameters, answering each with `answer`'s rows */
function fake(answer: (query: string) => Array<Record<string, unknown>>) {
	const sent: Array<[string, unknown[]]> = []
	return {
		sent,
		sql: {
			unsafe: async (query: string, params: unknown[]) => {
				sent.push([query, params])
				return answer(query)
			},
		} as unknown as Parameters<typeof heldBefore>[0],
	}
}

describe("validates", () => {
	it("is an ALTER TABLE with a VALIDATE CONSTRAINT among its commands", () => {
		expect(validates(...parsed("ALTER TABLE t ADD COLUMN x int, VALIDATE CONSTRAINT c;"))).toBe(true)
		expect(validates(...parsed("ALTER TABLE t ADD COLUMN x int;"))).toBe(false)
		expect(validates(...parsed("ALTER INDEX i SET (fillfactor = 70);"))).toBe(false)
		expect(validates(...parsed("SELECT 1;"))).toBe(false)
	})
})

describe("opens", () => {
	it("is a BEGIN, a START TRANSACTION, or a COMMIT or ROLLBACK AND CHAIN", () => {
		for (const sql of ["BEGIN;", "START TRANSACTION;", "COMMIT AND CHAIN;", "ROLLBACK AND CHAIN;"])
			expect(opens(parsed(sql)[1])).toBe(true)
		for (const sql of ["COMMIT;", "ROLLBACK;", "SAVEPOINT s;"]) expect(opens(parsed(sql)[1])).toBe(false)
	})
})

/* the snapshot at BEGIN: public.orders with its index, and s.items */
const OWNED = [
	{ name: "orders", of: "10", oid: "10", schema: "public" },
	{ name: "orders", of: "10", oid: "11", schema: "public" },
	{ name: "items", of: "20", oid: "20", schema: "s" },
]

describe("heldBefore", () => {
	it("keys each relation, and each index of one, by the relation's name under the schema", async () => {
		const { sql } = fake(() => OWNED)
		expect(await heldBefore(sql, "public")).toEqual(
			new Map([
				["10", { key: "orders", of: "10" }],
				["11", { key: "orders", of: "10" }],
				["20", { key: "s.items", of: "20" }],
			]),
		)
	})
})

/** What the transaction holds when pg_locks holds `locks` and pg_class names `names` now */
async function held(locks: Array<{ mode: string; oid: string }>, names: Array<Record<string, string>>) {
	const snapshot = fake(() => OWNED)
	const before = await heldBefore(snapshot.sql, "public")
	const dev = fake((query) => (query.includes("pg_locks") ? locks : names))
	return { held: await heldNow(dev.sql, before, "public"), sent: dev.sent }
}

describe("heldNow", () => {
	it("counts an index's lock as its table's, under the name the table has now", async () => {
		const { held: now, sent } = await held(
			[{ mode: "AccessExclusiveLock", oid: "11" }],
			[{ name: "orders2", oid: "10", schema: "s" }],
		)
		expect(now).toEqual(new Map([["s.orders2", true]]))
		expect(sent[1]?.[1]).toEqual(["10"])
	})

	it("blocks reads for ACCESS EXCLUSIVE alone, and keeps that through a weaker lock", async () => {
		const { held: now } = await held(
			[
				{ mode: "ShareLock", oid: "20" },
				{ mode: "AccessExclusiveLock", oid: "10" },
				{ mode: "ShareRowExclusiveLock", oid: "11" },
			],
			[
				{ name: "orders", oid: "10", schema: "public" },
				{ name: "items", oid: "20", schema: "s" },
			],
		)
		expect(now).toEqual(
			new Map([
				["s.items", false],
				["orders", true],
			]),
		)
	})

	it("names a relation the file dropped by the name it had, and leaves out one it made and the weak modes", async () => {
		const { held: now } = await held(
			[
				{ mode: "AccessExclusiveLock", oid: "20" },
				{ mode: "AccessExclusiveLock", oid: "99" },
				{ mode: "RowExclusiveLock", oid: "10" },
			],
			[],
		)
		expect(now).toEqual(new Map([["s.items", true]]))
	})

	it("asks pg_class nothing when the transaction holds nothing that blocks", async () => {
		const { held: now, sent } = await held([{ mode: "AccessShareLock", oid: "10" }], [])
		expect(now).toEqual(new Map())
		expect(sent).toHaveLength(1)
	})
})
