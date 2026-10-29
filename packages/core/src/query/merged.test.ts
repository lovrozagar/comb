import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { describe, expect, it } from "vitest"
import { SEALED } from "./__fixtures__/cursor-secret.ts"
import { paginate } from "./pagination.ts"
import { paginateMerged } from "./merged.ts"
import { createListQuerySchema } from "./schema.ts"
import { buildListQuery } from "./sqlite/build-list-query.ts"

const schema = createListQuerySchema({ pagination: { defaultLimit: 2, maxLimit: 10 }, sort: ["k"] })
const parse = (params: Record<string, string>) => schema.parse(params)
const t = sqliteTable("t", { id: text("id").primaryKey(), k: text("k") })
const numbered = sqliteTable("numbered", { id: text("id").primaryKey(), k: integer("k") })

/** The merged list under `params`, one builder for every shard's read and for the merge (K5 of r17) */
const merged = (params: Record<string, string>, maxRowsPerShard?: number, table: typeof t | typeof numbered = t) =>
	buildListQuery({ ...SEALED, merged: { maxRowsPerShard }, parsed: parse(params), table })

/** Hand-made rows as a shard reads them through the merged builder: the tiebreak, and each row's shard count on an offset page */
const read = <T extends { id: unknown }>(rows: readonly T[], total: number | null = rows.length) =>
	rows.map((row) => ({ ...row, _combId: row.id, ...(total === null ? {} : { _total: total }) }))

/** The ids of the merged page of `shards` under `params` */
const ids = (shards: Array<Array<{ id: unknown; k?: unknown }>>, params: Record<string, string>) =>
	paginateMerged(
		shards.map((rows) => read(rows, params["cursor"] === undefined ? rows.length : null)),
		merged(params),
	)[0].map((row) => row.id)

/* plan 14's 5.5: the parts tests/integration/d1/paginate-merged.test.ts does not reach on D1 */
describe("buildListQuery's merged list", () => {
	it("reads every row to the page's end and one more from each shard, counting them", () => {
		const options = merged({ limit: "3", page: "4" })
		expect(options).toMatchObject({ limit: 13, offset: 0 })
		expect(Object.keys(options.extras).toSorted()).toEqual(["_combId", "_total"])
		expect(merged({ limit: "3" })).toMatchObject({ limit: 4, offset: 0 })
	})

	it("refuses a page whose window passes what a shard may read, pointing to the cursor", () => {
		expect(() => merged({ limit: "10", page: "101" })).toThrow(
			expect.objectContaining({ errorKey: "page_too_deep", status: 400 }),
		)
		expect(() => merged({ limit: "2", page: "3" }, 6)).toThrow(
			expect.objectContaining({ cause: expect.stringMatching(/7 here, past 6; page by cursor instead$/) }),
		)
		expect(merged({ limit: "2", page: "3" }, 7).limit).toBe(7)
	})

	/* K8 of r17: a merged list pages through paginateMerged, a single database's through paginate */
	it("is refused by paginate, and paginateMerged refuses a single database's list", () => {
		const notWired = expect.objectContaining({ errorKey: "page_not_wired", status: 500 })
		// @ts-expect-error a merged list is no single database's
		expect(() => paginate(read([{ id: "a", k: "x" }]), merged({}))).toThrow(notWired)
		const single = buildListQuery({ ...SEALED, parsed: parse({}), table: t })
		// @ts-expect-error a single database's list is no merged one
		expect(() => paginateMerged([read([{ id: "a", k: "x" }])], single)).toThrow(notWired)
	})

	/* K8 of r17: a shard read with the single-database window carries no count, which paginateMerged refuses */
	it("refuses a page whose shard rows carry no count, where it paged page 1 for every page", () => {
		expect(() => paginateMerged([read([{ id: "a", k: "x" }], null)], merged({ page: "2" }))).toThrow(
			expect.objectContaining({ cause: expect.stringContaining("_total"), errorKey: "page_not_wired" }),
		)
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

	it("breaks a tie by the tiebreak in the first key's direction, and places nulls as the order says", () => {
		const shards = [[{ id: 1, k: 5 }], [{ id: 2, k: 5 }], [{ id: 3, k: null }], [{ id: 4, k: undefined }]]
		expect(ids(shards, { limit: "10", order: "k.desc" })).toEqual([4, 3, 2, 1])
		expect(ids(shards, { limit: "10", order: "k.desc.nullslast" })).toEqual([2, 1, 4, 3])
		expect(ids(shards, { limit: "10", order: "k.asc.nullsfirst" })).toEqual([3, 4, 1, 2])
		expect(ids(shards.slice(0, 2), { limit: "10", order: "k.asc" })).toEqual([1, 2])
	})

	it("orders by the tiebreak alone, descending, under an empty sort, as orderByKeys does", () => {
		/* a hand-built query: the schema adds a default order to an empty one */
		const unsorted = buildListQuery({ ...SEALED, merged: {}, parsed: { limit: 10, parsedSort: [] }, table: t })
		const [rows] = paginateMerged([read([{ id: 3 }, { id: 1 }]), read([{ id: 2 }])], unsorted)
		expect(rows.map((row) => row.id)).toEqual([3, 2, 1])
	})

	it("sums each shard's count, and none of a shard that read no row", () => {
		const counted = [read([{ id: "a", k: 1 }], 2), [], read([{ id: "b", k: 2 }], 1)]
		expect(paginateMerged(counted, merged({}))[1].count).toBe(3)
	})

	it("refuses a page past a gone anchor, and projects each row to the select", () => {
		const gone = [[{ ...read([{ id: "a", k: 1 }])[0], _combAnchorGone: 1 }]]
		expect(() => paginateMerged(gone, merged({}))).toThrow(expect.objectContaining({ errorKey: "invalid_cursor" }))
		const select = buildListQuery({
			...SEALED,
			merged: {},
			parsed: { ...parse({}), parsedFields: { root: { relations: {}, scalars: ["id"] } } },
			table: t,
		})
		expect(paginateMerged([read([{ id: "a", k: 1 }])], select)[0]).toEqual([{ id: "a" }])
	})
})

/* Q1 of the 0.14.1 review: a shard that resumed before the cursor, as one reading a gone anchor at -Infinity does */
/** A row of key `k` */
const row = (id: string, k: number) => ({ _combId: id, id, k })

describe("paginateMerged past a cursor a shard resumed before", () => {
	const first = paginateMerged(
		[read([row("a1", 1), row("a2", 3), row("a3", 5)], 3), read([row("b1", 2), row("b2", 4), row("b3", 6)], 3)],
		merged({ limit: "2", order: "k.asc" }, undefined, numbered),
	)
	const cursor = first[1].nextCursor as string

	it("serves no row at or before the cursor, and none past a shard's last row it may hold more before", () => {
		/* shard A resumed at the list's start; it holds a2.5 (k 3.5) too, which its read stopped before */
		const [items, meta] = paginateMerged(
			[
				[row("a0", 0), row("a1", 1), row("a2", 3)],
				[row("b2", 4), row("b3", 6), row("b4", 8)],
			],
			merged({ cursor, limit: "2", order: "k.asc" }, undefined, numbered),
		)
		expect(first[0].map(({ id }) => id)).toEqual(["a1", "b1"])
		expect(items.map(({ id }) => id)).toEqual(["a2"])
		expect(meta.hasMore).toBe(true)
		expect(meta.nextCursor).not.toBeNull()
	})
	it("refuses a shard that read its whole limit at or before the cursor, which could not move the list on", () => {
		const shards = [[row("a0", 0), row("a1", 1), row("a9", 1.5)], [row("b2", 4)]]
		expect(() => paginateMerged(shards, merged({ cursor, limit: "2", order: "k.asc" }, undefined, numbered))).toThrow(
			expect.objectContaining({ errorKey: "sort_not_wired", status: 500 }),
		)
	})

	/* Q1 of r17: a reference names a row only one shard holds, so a merged list never pages by one */
	it("refuses, on the page that meets it, a key too long for a cursor, where it paged forever by reference", () => {
		const long = "x".repeat(9000)
		const titled = (id: string, k: string) => ({ id, k: `${long}${k}` })
		expect(() =>
			paginateMerged(
				[read([titled("a1", "a"), titled("a2", "c")]), read([titled("b1", "b")])],
				merged({ limit: "1", order: "k.asc" }),
			),
		).toThrow(
			expect.objectContaining({
				cause: expect.stringMatching(/^a row's k is too long to page this list by: .*a merged list/),
				errorKey: "sort_not_wired",
				status: 500,
			}),
		)
	})
})

/* R1 of plan 16's review: a merged list mints no reference, so a cursor that carries one is no cursor of it */
describe("a merged list given a cursor that carries a reference", () => {
	it("refuses it as invalid_cursor, though a single database's list under its scope and sort minted it", () => {
		const long = { _combId: "a", _total: 2, id: "a", k: "x".repeat(9000) }
		const single = buildListQuery({ ...SEALED, parsed: parse({ limit: "1", order: "k.asc" }), table: t })
		const [, meta] = paginate([long, { ...long, _combId: "b", id: "b" }], single)
		const cursor = meta.nextCursor as string
		expect(() => merged({ cursor, limit: "1", order: "k.asc" })).toThrow(
			expect.objectContaining({ errorKey: "invalid_cursor", status: 400 }),
		)
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
