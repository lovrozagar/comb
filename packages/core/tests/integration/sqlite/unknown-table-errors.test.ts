/**
 * Q10 of r18: a violation on a table the maps given key nowhere names no column, as on Postgres.
 * Here `orders`' trigger writes `audit_raw`, which no map lists, as a table outside the drizzle
 * schema; on libsql, raw and under drizzle's wrapper.
 */
import { sql } from "drizzle-orm"
import { afterEach, describe, expect, it } from "vitest"
import { classifySqliteError } from "../../../src/sqlite/constraint-handler.ts"
import type { ConstraintMap } from "../../../src/types.ts"
import { type LibsqlHarness, libsqlMemory } from "../support/libsql.ts"

let harness: LibsqlHarness | undefined
afterEach(() => harness?.close())

const MAPS: ConstraintMap[] = [{ orders: { private: [] } }]

/** What `run` fails with */
const caught = (run: () => Promise<unknown>) =>
	run().then(
		() => new Error("the statement did not fail"),
		(error: unknown) => error,
	)

/** What `statement` fails with, raw and through drizzle, over orders and its trigger into audit_raw */
async function failures(statement: string): Promise<unknown[]> {
	harness = libsqlMemory()
	await harness.client.executeMultiple(`CREATE TABLE orders (id TEXT PRIMARY KEY, actor TEXT);
CREATE TABLE audit_raw (id INTEGER PRIMARY KEY, session_secret TEXT NOT NULL UNIQUE);
INSERT INTO audit_raw (session_secret) VALUES ('s');
CREATE TRIGGER orders_audit AFTER INSERT ON orders BEGIN INSERT INTO audit_raw (session_secret) VALUES (NEW.actor); END;`)
	const { client, db } = harness
	return [await caught(() => client.execute(statement)), await caught(() => db.run(sql.raw(statement)))]
}

describe("classifySqliteError on a table no map keys, a trigger's write", () => {
	it("names no column of a NOT NULL violation", async () => {
		for (const failure of await failures("INSERT INTO orders (id) VALUES ('o1')")) {
			const classified = classifySqliteError(failure, MAPS)
			expect(classified).toMatchObject({ cause: "Required field missing", table: "audit_raw" })
			expect(classified?.column).toBeUndefined()
		}
	})

	it("names no column of a UNIQUE violation, in its column or its cause", async () => {
		for (const failure of await failures("INSERT INTO orders (id, actor) VALUES ('o2', 's')")) {
			const classified = classifySqliteError(failure, MAPS)
			expect(classified).toMatchObject({ cause: "Duplicate value detected", status: 409, table: "audit_raw" })
			expect(classified?.column).toBeUndefined()
		}
	})
})

/** What a NOT NULL violation on ut_abc's title classifies as under `maps` */
async function missingTitle(maps: ConstraintMap[]) {
	harness = libsqlMemory()
	await harness.client.execute("CREATE TABLE ut_abc (id TEXT PRIMARY KEY, title TEXT NOT NULL)")
	const failure = await caught(() => harness!.db.run(sql.raw("INSERT INTO ut_abc (id) VALUES ('r1')")))
	return classifySqliteError(failure, maps)
}

/* R5 of plan 17: a runtime table no generated map can key, such as anyrow's ut_<id>, is known by a prefix pattern */
describe("classifySqliteError on a runtime table a prefix pattern keys", () => {
	it("names no column of it when no key covers it", async () => {
		const classified = await missingTitle([{ users: {} }])
		expect(classified).toMatchObject({ cause: "Required field missing", table: "ut_abc" })
		expect(classified?.column).toBeUndefined()
	})

	it("names its column under a `ut_*` key, as before the fail-closed rule", async () => {
		expect(await missingTitle([{ users: {}, "ut_*": {} }])).toMatchObject({
			cause: "Required field missing: title",
			column: "title",
			table: "ut_abc",
		})
	})
})
