/// <reference types="bun-types" />
/**
 * Round four of area B on bun:sqlite: a key column holding what its drizzle mode does not read back
 * as stored pages every row once on a list that reads the key back, and answers a 500 naming the key
 * on one that binds it as read, on the page that serves the row, never a 400, a repeat, a skip or a
 * loop. tests/integration/sqlite and tests/integration/d1 run the same on libsql and D1.
 */
import { Database } from "bun:sqlite"
import { afterEach, describe, expect, it } from "bun:test"
import { drizzle } from "drizzle-orm/bun-sqlite"
import {
	INTEGER_TEXT,
	JSON_OBJECT,
	JSON_TEXT,
	LONG_BETWEEN,
	type OpenDb,
	REAL_TEXT,
	refusedOnPage,
	storedProblems,
	TEXT_BLOB,
	UNTYPED_TEXT,
} from "../integration/support/stored-keys.ts"

const clients: Database[] = []
afterEach(() => {
	for (const client of clients.splice(0)) client.close()
})

const open: OpenDb = (statements, relations) => {
	const client = new Database(":memory:")
	clients.push(client)
	for (const statement of statements) client.run(statement)
	return Promise.resolve(drizzle({ client, relations: relations as never }) as never)
}

describe("a cursor the list minted is never refused as invalid_cursor (AB4-1 of area B)", () => {
	it("answers a JSON-mode key the 500 naming it on every list kind, never a 400", async () => {
		expect(await storedProblems(open, JSON_TEXT, { limits: [1, 2], refusing: () => true })).toEqual([])
	})

	it.each([
		["REAL", REAL_TEXT],
		["INTEGER", INTEGER_TEXT],
		["untyped", UNTYPED_TEXT],
	] as const)("pages a %s key holding TEXT, never a 400", async (_, kase) => {
		expect(await storedProblems(open, kase)).toEqual([])
	})

	it("answers a TEXT key holding a BLOB the 500 naming it, never a 400", async () => {
		expect(await storedProblems(open, TEXT_BLOB, { refusing: () => true })).toEqual([])
	})
})

describe("a row no cursor holds is refused on the page that serves it, at any page size (AB4-3 of area B)", () => {
	it("answers the 500 on page 1 for a key past the cap the page serves before its last row", async () => {
		expect(await refusedOnPage(open, LONG_BETWEEN, { direction: "desc", kind: "anchorless", limit: 2 })).toEqual({
			error: "sort_not_wired",
			ids: [],
			page: 1,
		})
	})

	it("answers the 500 on page 1 for a JSON object on a table list that ends on that page", async () => {
		expect(await refusedOnPage(open, JSON_OBJECT, { direction: "desc", kind: "table", limit: 3 })).toEqual({
			error: "sort_not_wired",
			ids: [],
			page: 1,
		})
	})

	/* the timestamp BLOB libsql reads as an Invalid Date this driver reads as Date(1): AB4-2's timestamp_ms dataset holds it */
})
