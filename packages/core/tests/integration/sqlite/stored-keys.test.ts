/**
 * Round four of area B on libsql: a key column holding what its drizzle mode does not read back as
 * stored pages every row once on a list that reads the key back, and answers a 500 naming the key on
 * one that binds it as read, on the page that serves the row, never a 400, a repeat, a skip or a loop
 * (support/stored-keys.ts). tests/integration/d1 and tests/bun run the same on D1 and bun:sqlite.
 */
import { type Client, createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import { afterEach, describe, expect, it } from "vitest"
import {
	HELD_REALS,
	HELD_UNPRINTED,
	INTEGER_TEXT,
	JSON_OBJECT,
	JSON_TEXT,
	LONG_BETWEEN,
	type OpenDb,
	REAL_TEXT,
	refusedOnPage,
	STORED_CLASSES,
	storedProblems,
	TEXT_BLOB,
	TIMESTAMP_BLOB,
	UNTYPED_TEXT,
} from "../support/stored-keys.ts"

const clients: Client[] = []
afterEach(() => {
	for (const client of clients.splice(0)) client.close()
})

const open: OpenDb = async (statements, relations) => {
	const client = createClient({ url: ":memory:" })
	clients.push(client)
	for (const statement of statements) await client.execute(statement)
	return drizzle({ client, relations: relations as never }) as never
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

	/* AB4-2 of area B: a BLOB is outside what a text column reads back as stored, so a list reading it back carries it */
	it("pages a TEXT key holding a BLOB, or refuses it by name on a list that binds it as read, never a 400", async () => {
		expect(await storedProblems(open, TEXT_BLOB)).toEqual([])
	})
})

describe("a stored class a key's mode reads apart pages or is refused by name (AB4-2 of area B)", () => {
	it.each(Object.entries(STORED_CLASSES))("%s", async (_, kase) => {
		expect(await storedProblems(open, kase)).toEqual([])
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

	it("answers the 500 on the page that serves a timestamp BLOB libsql reads as an Invalid Date", async () => {
		expect(await refusedOnPage(open, TIMESTAMP_BLOB, { direction: "asc", kind: "anchorless", limit: 2 })).toEqual({
			error: "sort_not_wired",
			ids: ["r0", "r3"],
			page: 2,
		})
	})
})

describe("a REAL a key's mode reads apart pages exactly where a text of it reads back, on libsql (AB4-7 of area B)", () => {
	it.each(
		Object.entries({ ...HELD_REALS, "text() holding a REAL D1 prints no text of that reads back": HELD_UNPRINTED }),
	)("%s", async (_, kase) => {
		expect(await storedProblems(open, kase)).toEqual([])
	})
})
