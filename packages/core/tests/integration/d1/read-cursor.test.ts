/**
 * AB3-3 of area B on D1: readCursor returns each sort key as the cursor's row read it on every list
 * kind, D1's null for a REAL Infinity and a blob read as an array included (support/read-cursor.ts)
 */
import { drizzle } from "drizzle-orm/d1"
import { afterEach, describe, expect, it } from "vitest"
import { type D1Harness, d1Memory } from "../support/d1.ts"
import {
	asCursorReads,
	READ_KEYS,
	READ_KINDS,
	type ReadKey,
	type ReadKind,
	readBack,
	readSeed,
} from "../support/read-cursor.ts"

const shards: D1Harness[] = []
afterEach(async () => {
	await Promise.all(shards.splice(0).map((shard) => shard.dispose()))
})

/** A D1 database seeded with `statements` */
async function holding(statements: readonly string[]) {
	const shard = await d1Memory()
	shards.push(shard)
	for (const statement of statements) await shard.CORE.prepare(statement).run()
	return drizzle(shard.CORE)
}

/** One database holding both rows, or two shards holding one each for the merged list */
const dbsFor = async (key: ReadKey, kind: ReadKind) =>
	kind === "merged"
		? [await holding(readSeed(key, ["a"])), await holding(readSeed(key, ["b"]))]
		: [await holding(readSeed(key))]

describe("readCursor returns each key as the row read it, on D1 (AB3-3 of area B)", () => {
	it.each(["blob", "numeric integer", "numeric real", "real infinity"] as const)(
		"returns a %s key as its row read it on every list",
		async (name) => {
			const key = READ_KEYS[name]
			for (const kind of READ_KINDS) {
				const { back, read } = await readBack(await dbsFor(key, kind), key, kind)
				expect(back, kind).toEqual(asCursorReads(read))
			}
		},
	)
})
