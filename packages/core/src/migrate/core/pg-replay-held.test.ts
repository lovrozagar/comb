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

/* the snapshot at BEGIN: public.orders with its index, s.items, and the sequence ids */
const OWNED = [
	{ name: "orders", of: "10", oid: "10", schema: "public", sequence: false },
	{ name: "orders", of: "10", oid: "11", schema: "public", sequence: false },
	{ name: "items", of: "20", oid: "20", schema: "s", sequence: false },
	{ name: "ids", of: "30", oid: "30", schema: "public", sequence: true },
]

describe("heldBefore", () => {
	it("keys each relation, and each index of one, by the relation's name under the schema", async () => {
		const { sql } = fake(() => OWNED)
		expect(await heldBefore(sql, "public")).toEqual(
			new Map([
				["10", { key: "orders", of: "10", sequence: false }],
				["11", { key: "orders", of: "10", sequence: false }],
				["20", { key: "s.items", of: "20", sequence: false }],
				["30", { key: "ids", of: "30", sequence: true }],
			]),
		)
	})
})

/** What the transaction holds when pg_locks holds `locks`, pg_class names `names` now, and pg_depend says `calls` */
async function heldAll(
	locks: Array<{ mode: string; oid: string }>,
	names: Array<Record<string, string>>,
	calls: Array<Record<string, unknown>> = [],
) {
	const snapshot = fake(() => OWNED)
	const before = await heldBefore(snapshot.sql, "public")
	const dev = fake((query) => (query.includes("pg_locks") ? locks : query.includes("pg_depend") ? calls : names))
	return { locked: await heldNow(dev.sql, before, "public"), sent: dev.sent }
}

/** What the transaction holds of each relation, as `heldAll` reads it */
async function held(locks: Array<{ mode: string; oid: string }>, names: Array<Record<string, string>>) {
	const { locked, sent } = await heldAll(locks, names)
	expect(locked.calls).toEqual(new Map())
	return { held: locked.locks, sent }
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

/* AE2-3 of r22: a sequence is held by its own name, and the warning names the tables that call it */
describe("heldNow of a sequence", () => {
	it("names the tables there at BEGIN whose default or identity calls a sequence it holds, by their names now", async () => {
		const { locked, sent } = await heldAll(
			[{ mode: "ShareRowExclusiveLock", oid: "30" }],
			[
				{ name: "ids2", oid: "30", schema: "public" },
				{ name: "orders", oid: "10", schema: "public" },
				{ name: "items2", oid: "20", schema: "s" },
			],
			[
				{ caller: "20", identity: false, sequence: "30" },
				{ caller: "10", identity: false, sequence: "30" },
				{ caller: "10", identity: true, sequence: "30" },
				{ caller: "99", identity: false, sequence: "30" },
				{ caller: "11", identity: false, sequence: "30" },
			],
		)
		expect(locked).toEqual({
			calls: new Map([["ids2", { defaults: ["orders", "s.items2"], identity: "orders" }]]),
			locks: new Map([["ids2", false]]),
		})
		expect(sent[1]?.[1]).toEqual(["30"])
		expect(sent[2]?.[1]).toEqual(["30,20,10"])
	})

	it("asks pg_depend nothing when no sequence is held", async () => {
		const { sent } = await held(
			[{ mode: "AccessExclusiveLock", oid: "10" }],
			[{ name: "orders", oid: "10", schema: "public" }],
		)
		expect(sent.map(([query]) => query.includes("pg_depend"))).toEqual([false, false])
	})
})
