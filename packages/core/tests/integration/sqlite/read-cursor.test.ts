/**
 * AB3-3 of area B on libsql: readCursor returns each sort key as the cursor's row read it on every
 * list kind, a key the list binds as another value included (support/read-cursor.ts)
 */
import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import { afterEach, describe, expect, it } from "vitest"
import {
	asCursorReads,
	READ_KEYS,
	READ_KINDS,
	type ReadKey,
	type ReadKind,
	readBack,
	readSeed,
} from "../support/read-cursor.ts"

const clients: Array<ReturnType<typeof createClient>> = []
afterEach(() => {
	for (const client of clients.splice(0)) client.close()
})

/** A libsql database in memory, integers read as `intMode`, seeded with `statements` */
async function holding(statements: readonly string[], intMode: "number" | "string") {
	const client = createClient({ intMode, url: ":memory:" })
	clients.push(client)
	for (const statement of statements) await client.execute(statement)
	return drizzle({ client })
}

/** One database holding both rows, or two shards holding one each for the merged list */
const dbsFor = async (key: ReadKey, kind: ReadKind, intMode: "number" | "string") =>
	kind === "merged"
		? [await holding(readSeed(key, ["a"]), intMode), await holding(readSeed(key, ["b"]), intMode)]
		: [await holding(readSeed(key), intMode)]

const CASES = [
	...(["blob", "numeric integer", "numeric real", "real infinity"] as const).map((key) => [key, "number"] as const),
	...(["integer", "numeric integer"] as const).map((key) => [key, "string"] as const),
]

describe("readCursor returns each key as the row read it, on libsql (AB3-3 of area B)", () => {
	it.each(CASES)("returns a %s key read with intMode %s as its row read it on every list", async (name, intMode) => {
		const key = READ_KEYS[name]
		for (const kind of READ_KINDS) {
			const { back, read } = await readBack(await dbsFor(key, kind, intMode), key, kind)
			expect(back, kind).toEqual(asCursorReads(read))
		}
	})
})
