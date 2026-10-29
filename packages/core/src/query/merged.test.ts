import { describe, expect, it } from "vitest"
import { built } from "./__fixtures__/built.ts"
import { SEALED } from "./__fixtures__/cursor-secret.ts"
import { mergedListOptions, paginateMerged } from "./merged.ts"
import { createListQuerySchema } from "./schema.ts"

const schema = createListQuerySchema({ pagination: { defaultLimit: 2, maxLimit: 10 }, sort: ["k"] })
const parse = (params: Record<string, string>) => schema.parse(params)

/** The ids of the merged page of `shards` under `params` */
const ids = (shards: Array<Array<Record<string, unknown>>>, params: Record<string, string>) =>
	paginateMerged(shards, mergedListOptions(parse(params), SEALED))[0].map((row) => (row as { id: unknown }).id)

/* plan 14's 5.5: the parts tests/integration/d1/paginate-merged.test.ts does not reach on D1 */
describe("mergedListOptions", () => {
	it("reads every row to the page's end and one more from each shard, counting them", () => {
		const options = mergedListOptions(parse({ limit: "3", page: "4" }), SEALED)
		expect(options).toMatchObject({ limit: 13, offset: 0 })
		expect(Object.keys(options.extras ?? {})).toEqual(["_total"])
		expect(mergedListOptions(parse({ limit: "3" }), SEALED)).toMatchObject({ limit: 4, offset: 0 })
	})

	it("refuses a page whose window passes what a shard may read, pointing to the cursor", () => {
		expect(() => mergedListOptions(parse({ limit: "10", page: "101" }), SEALED)).toThrow(
			expect.objectContaining({ errorKey: "page_too_deep", status: 400 }),
		)
		expect(() => mergedListOptions(parse({ limit: "2", page: "3" }), { ...SEALED, maxRowsPerShard: 6 })).toThrow(
			expect.objectContaining({ cause: expect.stringMatching(/7 here, past 6; page by cursor instead$/) }),
		)
		expect(mergedListOptions(parse({ limit: "2", page: "3" }), { ...SEALED, maxRowsPerShard: 7 }).limit).toBe(7)
	})
})

describe("paginateMerged", () => {
	it("orders each storage class as SQLite does: numbers, booleans and dates before text, text before a blob", () => {
		const shards = [
			/* each shard's rows in its own order, as its ORDER BY returns them */
			[
				{ id: "c", k: 2n },
				{ id: "a", k: "x" },
				{ id: "b", k: new Uint8Array([2]) },
			],
			[
				{ id: "e", k: new Date(0) },
				{ id: "d", k: true },
				{ id: "g", k: new Uint8Array([1]) },
				{ id: "f", k: new Uint8Array([1, 9]) },
			],
		]
		expect(ids(shards, { limit: "10", order: "k.asc" })).toEqual(["e", "d", "c", "a", "g", "f", "b"])
	})

	it("breaks a tie by id in the first key's direction, and places nulls as the order says", () => {
		const shards = [[{ id: 1, k: 5 }], [{ id: 2, k: 5 }], [{ id: 3, k: null }], [{ id: 4, k: undefined }]]
		expect(ids(shards, { limit: "10", order: "k.desc" })).toEqual([4, 3, 2, 1])
		expect(ids(shards, { limit: "10", order: "k.desc.nullslast" })).toEqual([2, 1, 4, 3])
		expect(ids(shards, { limit: "10", order: "k.asc.nullsfirst" })).toEqual([3, 4, 1, 2])
	})

	it("orders by the id alone, descending, under an empty sort, as orderByKeys does", () => {
		const query = { limit: 10, parsedSort: [] }
		const [rows] = paginateMerged([[{ id: 3 }, { id: 1 }], [{ id: 2 }]], built(query, SEALED))
		expect(rows.map((row) => row.id)).toEqual([3, 2, 1])
	})

	it("counts nothing once a shard's rows carry no count, and none of a shard that read no row", () => {
		const counted: Array<Array<{ _total?: number; id: string; k: number }>> = [
			[{ _total: 2, id: "a", k: 1 }],
			[],
			[{ _total: 1, id: "b", k: 2 }],
		]
		expect(paginateMerged(counted, mergedListOptions(parse({}), SEALED))[1].count).toBe(3)
		expect(paginateMerged([...counted, [{ id: "c", k: 3 }]], mergedListOptions(parse({}), SEALED))[1].count).toBeNull()
	})

	it("refuses a page past a gone anchor, and projects each row to the select", () => {
		const gone = [[{ _combAnchorGone: 1, id: "a", k: 1 }]]
		expect(() => paginateMerged(gone, mergedListOptions(parse({}), SEALED))).toThrow(
			expect.objectContaining({ errorKey: "invalid_cursor" }),
		)
		const query = { ...parse({}), parsedFields: { root: { relations: {}, scalars: ["id"] } } }
		expect(paginateMerged([[{ _total: 1, id: "a", k: 1 }]], mergedListOptions(query, SEALED))[0]).toEqual([{ id: "a" }])
	})
})

/* Q1 of the 0.14.1 review: a shard that resumed before the cursor, as one reading a gone anchor at -Infinity does */
/** A row of key `k` */
const row = (id: string, k: number) => ({ id, k })

describe("paginateMerged past a cursor a shard resumed before", () => {
	const first = paginateMerged(
		[
			[row("a1", 1), row("a2", 3), row("a3", 5)],
			[row("b1", 2), row("b2", 4), row("b3", 6)],
		],
		mergedListOptions(parse({ limit: "2", order: "k.asc" }), SEALED),
	)
	const cursor = first[1].nextCursor as string

	it("serves no row at or before the cursor, and none past a shard's last row it may hold more before", () => {
		/* shard A resumed at the list's start; it holds a2.5 (k 3.5) too, which its read stopped before */
		const [items, meta] = paginateMerged(
			[
				[row("a0", 0), row("a1", 1), row("a2", 3)],
				[row("b2", 4), row("b3", 6), row("b4", 8)],
			],
			mergedListOptions(parse({ cursor, limit: "2", order: "k.asc" }), SEALED),
		)
		expect(first[0].map(({ id }) => id)).toEqual(["a1", "b1"])
		expect(items.map(({ id }) => id)).toEqual(["a2"])
		expect(meta.hasMore).toBe(true)
		expect(meta.nextCursor).not.toBeNull()
	})
	it("refuses a shard that read its whole limit at or before the cursor, which could not move the list on", () => {
		const shards = [[row("a0", 0), row("a1", 1), row("a9", 1.5)], [row("b2", 4)]]
		expect(() =>
			paginateMerged(shards, mergedListOptions(parse({ cursor, limit: "2", order: "k.asc" }), SEALED)),
		).toThrow(expect.objectContaining({ errorKey: "sort_not_wired", status: 500 }))
	})

	it("pages past a cursor that carries a long key by reference, which no row's value equals", () => {
		const long = "x".repeat(9000)
		const text = (id: string, k: string) => ({ id, k: `${long}${k}` })
		const [, meta] = paginateMerged(
			[[text("a1", "a"), text("a2", "c")], [text("b1", "b")]],
			mergedListOptions(parse({ limit: "1", order: "k.asc" }), SEALED),
		)
		const [items] = paginateMerged(
			[[text("a2", "c")], [text("b1", "b")]],
			mergedListOptions(parse({ cursor: meta.nextCursor as string, limit: "1", order: "k.asc" }), SEALED),
		)
		expect(items.map(({ id }) => id)).toEqual(["b1"])
	})
})

/* Q10 of the 0.14.1 review: a merged list's ids must be unique across shards, or a cursor's anchor is ambiguous */
describe("paginateMerged on an id two shards hold", () => {
	it("refuses the merge", () => {
		expect(() => ids([[{ id: "x", k: 1 }], [{ id: "x", k: 2 }]], { order: "k.asc" })).toThrow(
			expect.objectContaining({ errorKey: "sort_not_wired", status: 500 }),
		)
	})
})
