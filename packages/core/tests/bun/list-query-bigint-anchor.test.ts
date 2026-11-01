/// <reference types="bun-types" />
/**
 * Q1 of r18 on bun:sqlite, whose default mode reads an integer past 2^53 as the double nearest it:
 * a cursor whose anchor row is gone, as on every shard of a merged list but the anchor's, resumes
 * from the edge of that double's rounding interval toward the rows still to serve. It repeats rows
 * that round to the anchor's value and skips none, whichever way the value rounded. Doubles are 256
 * apart at 2^60: 2^60+200 reads as 2^60+256 (up), and 2^60+50 as 2^60 (down).
 */
import { Database } from "bun:sqlite"
import { describe, expect, it } from "bun:test"
import { getTableColumns } from "drizzle-orm"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { SEALED } from "../../src/query/__fixtures__/cursor-secret.ts"
import { queryHelpers } from "../../src/query/drizzle.ts"
import { paginateMerged } from "../../src/query/merged.ts"
import { createListQuerySchema } from "../../src/query/schema.ts"
import { applyListQuery, buildListQuery } from "../../src/query/sqlite/build-list-query.ts"

const org = sqliteTable("org", { id: text("id").primaryKey(), score: integer("score") })
const schema = createListQuerySchema({ pagination: { defaultLimit: 1, maxLimit: 5 }, sort: ["score"] })

/** A database holding `ids`, each with the score `value` */
function holding(value: string, ...ids: string[]) {
	const client = new Database(":memory:")
	client.run("CREATE TABLE org (id TEXT PRIMARY KEY, score INTEGER)")
	for (const id of ids) client.run(`INSERT INTO org VALUES ('${id}', ${value})`)
	return { client, db: drizzle({ client }) }
}

type Built = Parameters<typeof applyListQuery>[1]
const read = (db: ReturnType<typeof drizzle>, built: Built) =>
	applyListQuery((extras) => db.select({ ...getTableColumns(org), ...extras }).from(org), built)

const parse = (order: string, limit: number, cursor?: string) =>
	schema.parse({ limit: String(limit), order, ...(cursor === undefined ? {} : { cursor }) })

const ROUNDINGS = [
	["up", "1152921504606847176"],
	["down", "1152921504606847026"],
] as const

describe("a cursor over an integer key past 2^53 whose anchor row is gone (Q1 of r18)", () => {
	for (const [rounds, value] of ROUNDINGS) {
		for (const order of ["score.asc", "score.desc"]) {
			it(`resumes on one database after the anchor is deleted, skipping no row (${order}, rounded ${rounds})`, async () => {
				const { client, db } = holding(value, "a", "b", "c")
				const first = buildListQuery({ ...SEALED, parsed: parse(order, 1), table: org })
				const [page, meta] = queryHelpers.paginate(await read(db, first), first)
				client.run(`DELETE FROM org WHERE id = '${page[0]?.id}'`)
				const next = buildListQuery({ ...SEALED, parsed: parse(order, 5, meta.nextCursor as string), table: org })
				const [rest] = queryHelpers.paginate(await read(db, next), next)
				expect(rest.map(({ id }) => id)).toEqual(order === "score.asc" ? ["b", "c"] : ["b", "a"])
				client.close()
			})

			it(`pages a merged list as one database would (${order}, rounded ${rounds})`, async () => {
				const shards = [holding(value, "a"), holding(value, "b")]
				const seen: string[] = []
				let cursor: string | undefined
				for (let page = 0; page < 4; page++) {
					const built = buildListQuery({ ...SEALED, merged: {}, parsed: parse(order, 1, cursor), table: org })
					const [items, meta] = paginateMerged(await Promise.all(shards.map(({ db }) => read(db, built))), built)
					seen.push(...items.map(({ id }) => id))
					if (meta.nextCursor === null) break
					cursor = meta.nextCursor
				}
				expect(seen).toEqual(order === "score.asc" ? ["a", "b"] : ["b", "a"])
				for (const { client } of shards) client.close()
			})
		}
	}
})
