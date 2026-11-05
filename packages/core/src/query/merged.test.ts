import { type SQL, sql } from "drizzle-orm"
import { bigint, numeric, pgTable, text as pgText } from "drizzle-orm/pg-core"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { describe, expect, it } from "vitest"
import { SEALED } from "./__fixtures__/cursor-secret.ts"
import { paginate } from "./pagination.ts"
import { paginateMerged } from "./merged.ts"
import { createListQuerySchema } from "./schema.ts"
import { buildDerivedListQuery, buildListQuery } from "./sqlite/build-list-query.ts"

const schema = createListQuerySchema({ pagination: { defaultLimit: 2, maxLimit: 10 }, sort: ["k"] })
const parse = (params: Record<string, string>) => schema.parse(params)
const t = sqliteTable("t", { id: text("id").primaryKey(), k: text("k") })
const numbered = sqliteTable("numbered", { id: text("id").primaryKey(), k: integer("k") })

/** The merged list under `params`, one builder for every shard's read and for the merge (K5 of r17) */
const merged = (params: Record<string, string>, maxRowsPerShard?: number, table: typeof t | typeof numbered = t) =>
	buildListQuery({ ...SEALED, merged: { maxRowsPerShard }, parsed: parse(params), table })

/** The storage class SQLite holds `value` in, as the builder's typeof() answers for a value a driver read so */
function stored(value: unknown): string {
	if (value === null || value === undefined) return "null"
	if (typeof value === "string") return "text"
	if (value instanceof Uint8Array) return "blob"
	if (value === Number.POSITIVE_INFINITY) return "+inf"
	if (value === Number.NEGATIVE_INFINITY) return "-inf"
	return typeof value === "number" && !Number.isInteger(value) ? "real" : "integer"
}

/**
 * Hand-made rows as a shard reads them through the merged builder: the tiebreak, the storage class
 * of each of `sort`'s keys and of the id, and each row's shard count on an offset page
 */
const read = <T extends { id: unknown }>(rows: readonly T[], total: number | null = rows.length, sort = ["k"]) =>
	rows.map((row) => ({
		...row,
		_combId: row.id,
		_combKeyTypes: [...sort.map((field) => stored((row as Record<string, unknown>)[field])), stored(row.id)].join(","),
		...(total === null ? {} : { _total: total }),
	}))

/** A merged derived list under `params`, over rows with an id and a k */
const derived = (params: Record<string, string>) =>
	buildDerivedListQuery({
		...SEALED,
		dialect: "sqlite",
		idColumn: sql`id`,
		merged: {},
		parsed: parse(params),
		sortColumns: { k: sql`k` },
	})

/**
 * The ids of the merged page of `shards` under `params`, on a derived list: its keys are expressions,
 * which hold a value of any storage class, where a table's column refuses one its mode does not read (AB4-1)
 */
const ids = (shards: Array<Array<{ id: unknown; k?: unknown }>>, params: Record<string, string>) =>
	paginateMerged(
		shards.map((rows) => read(rows, params["cursor"] === undefined ? rows.length : null)),
		derived(params),
	)[0].map((row) => row.id)

/* plan 14's 5.5: the parts tests/integration/d1/paginate-merged.test.ts does not reach on D1 */
describe("buildListQuery's merged list", () => {
	it("reads every row to the page's end and one more from each shard, counting them", () => {
		const options = merged({ limit: "3", page: "4" })
		expect(options).toMatchObject({ limit: 13, offset: 0 })
		expect(Object.keys(options.extras).toSorted()).toEqual(["_combId", "_combKeyTypes", "_total"])
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
	/* a key's class mixes on an expression alone: a column's mode refuses the class it does not read (AB4-1 of area B) */
	it("orders each storage class as SQLite does: numbers and booleans before text, text before a blob", () => {
		const shards = [
			/* each shard's rows in its own order, as its ORDER BY returns them */
			[
				{ id: "c", k: 2n },
				{ id: "a", k: "x" },
				{ id: "b", k: new Uint8Array([2]) },
			],
			[
				{ id: "d", k: true },
				{ id: "g", k: new Uint8Array([1]) },
				{ id: "f", k: new Uint8Array([1, 9]) },
			],
		]
		expect(ids(shards, { limit: "10", order: "k.asc" })).toEqual(["d", "c", "a", "g", "f", "b"])
	})

	it("breaks a tie by the tiebreak in the first key's direction, and places nulls as the order says", () => {
		const shards = [[{ id: 1, k: 5 }], [{ id: 2, k: 5 }], [{ id: 3, k: null }], [{ id: 4, k: null }]]
		expect(ids(shards, { limit: "10", order: "k.desc" })).toEqual([4, 3, 2, 1])
		expect(ids(shards, { limit: "10", order: "k.desc.nullslast" })).toEqual([2, 1, 4, 3])
		expect(ids(shards, { limit: "10", order: "k.asc.nullsfirst" })).toEqual([3, 4, 1, 2])
		expect(ids(shards.slice(0, 2), { limit: "10", order: "k.asc" })).toEqual([1, 2])
		/* a key a row lacks sorts as a null, and is refused once served: no cursor resumes after it (AB4-3 of area B) */
		const unread = [...shards.slice(0, 3), [{ id: 4, k: undefined }]]
		expect(ids(unread, { limit: "3", order: "k.asc" })).toEqual([1, 2, 3])
		expect(() => ids(unread, { limit: "10", order: "k.asc" })).toThrow(
			expect.objectContaining({ errorKey: "sort_not_wired", status: 500 }),
		)
	})

	it("orders by the tiebreak alone, descending, under an empty sort, as orderByKeys does", () => {
		/* a hand-built query: the schema adds a default order to an empty one */
		const unsorted = buildListQuery({ ...SEALED, merged: {}, parsed: { limit: 10, parsedSort: [] }, table: t })
		const [rows] = paginateMerged([read([{ id: "c" }, { id: "a" }], 2, []), read([{ id: "b" }], 1, [])], unsorted)
		expect(rows.map((row) => row.id)).toEqual(["c", "b", "a"])
	})
})

describe("paginateMerged and a key's column (AB4-1 of area B)", () => {
	/* AB4-1 of area B: the cursor after such a row is one the next page's open would refuse as a 400 */
	it("answers the 500 naming the key for a row whose TEXT column holds a number, never minting its cursor", () => {
		expect(() => paginateMerged([read([{ id: "a", k: 1 }])], merged({}))).toThrow(
			expect.objectContaining({
				cause: expect.stringMatching(/^the sort by k reads a value its column's mode does not hold/),
				errorKey: "sort_not_wired",
				status: 500,
			}),
		)
	})

	it("merges a key declared as time by its epoch milliseconds, where the rows read it as a Date", () => {
		const built = buildDerivedListQuery({
			...SEALED,
			dialect: "sqlite",
			idColumn: sql`id`,
			merged: {},
			parsed: parse({ order: "k.desc" }),
			sortColumns: { k: { sql: sql`k`, type: "date" } },
		})
		const shards = [
			read([{ id: "a", k: new Date(1) }]),
			read([
				{ id: "b", k: new Date(3) },
				{ id: "c", k: new Date(2) },
			]),
		]
		expect(paginateMerged(shards, built)[0].map(({ id }) => id)).toEqual(["b", "c"])
	})
})

describe("paginateMerged's count and projection", () => {
	it("sums each shard's count, and none of a shard that read no row", () => {
		const counted = [read([{ id: "a", k: "1" }], 2), [], read([{ id: "b", k: "2" }], 1)]
		expect(paginateMerged(counted, merged({}))[1].count).toBe(3)
	})

	it("refuses a page past a gone anchor, and projects each row to the select", () => {
		const gone = [[{ ...read([{ id: "a", k: "1" }])[0], _combAnchorGone: 1 }]]
		expect(() => paginateMerged(gone, merged({}))).toThrow(expect.objectContaining({ errorKey: "invalid_cursor" }))
		const select = buildListQuery({
			...SEALED,
			merged: {},
			parsed: { ...parse({}), parsedFields: { root: { relations: {}, scalars: ["id"] } } },
			table: t,
		})
		expect(paginateMerged([read([{ id: "a", k: "1" }])], select)[0]).toEqual([{ id: "a" }])
	})
})

/* Q1 of the 0.14.1 review: a shard that resumed before the cursor, as one reading a gone anchor at -Infinity does */
/** A row of key `k`, with its storage class and its text id's */
const row = (id: string, k: number) => ({ _combId: id, _combKeyTypes: `${stored(k)},text`, id, k })

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

	/* Q6 of r20: unique INTEGER ids past 2^53 that a driver rounded onto one double are rounded, not shared */
	it("refuses ids a driver read rounded onto one number as rounded, naming how to read them exactly", () => {
		const rounded = 2 ** 60 + 256
		expect(() => ids([[{ id: rounded, k: 1 }], [{ id: rounded, k: 2 }]], { order: "k.asc" })).toThrow(
			expect.objectContaining({
				cause: expect.stringMatching(
					/^the tiebreak id _combId reads 1152921504606847200, past 2\^53, where a JS number rounds it/,
				),
				errorKey: "sort_not_wired",
			}),
		)
	})
})

/* r18 Q2: the merge cannot order integer keys the driver already rounded, and one database orders them by their true values */
describe("paginateMerged on an integer sort key past 2^53", () => {
	it("refuses a key a driver read as a rounded number, naming the field", () => {
		const built = merged({ order: "k.asc" })
		const shards = [read([{ id: "b", k: 2 ** 60 + 256 }]), read([{ id: "a", k: 2 ** 60 + 256 }])]
		expect(() => paginateMerged(shards, built)).toThrow(
			expect.objectContaining({
				cause:
					"k 1152921504606847232 is past ±(2^53 − 1), where the driver rounded it: a merged list's integer sort keys must be within ±(2^53 − 1), or be read as bigint",
				errorKey: "sort_not_wired",
				status: 500,
			}),
		)
	})

	it("merges keys within the bound, and keys a driver read as bigint, by their values", () => {
		const built = merged({ order: "k.asc" }, undefined, numbered)
		const exact = [read([{ id: "b", k: 2n ** 60n + 10n }]), read([{ id: "a", k: 2n ** 60n + 20n }])]
		expect(paginateMerged(exact, built)[0].map(({ id }) => id)).toEqual(["b", "a"])
		const safe = [read([{ id: "b", k: 2 ** 53 - 1 }]), read([{ id: "a", k: -(2 ** 53 - 1) }])]
		expect(paginateMerged(safe, built)[0].map(({ id }) => id)).toEqual(["a", "b"])
	})
})

/* r18 Q12: a derived list, a union or a join, merged across shards as a table's is */
describe("buildDerivedListQuery's merged list", () => {
	it("is a merged list paginateMerged pages: each shard's window and count, the order across shards", () => {
		const first = derived({ limit: "2", order: "k.asc" })
		expect([first.pagination.merged, [...first.pagination.expects].sort()]).toEqual([
			true,
			["_combId", "_combKeyTypes", "_total"],
		])
		const shards = [
			read([
				{ id: "a", k: "1" },
				{ id: "c", k: "3" },
			]),
			read([{ id: "b", k: "2" }]),
		]
		const [page, meta] = paginateMerged(shards, first)
		expect([page.map(({ id }) => id), meta.count, meta.hasMore]).toEqual([["a", "b"], 3, true])
		const next = derived({ cursor: meta.nextCursor as string, limit: "2", order: "k.asc" })
		const rest = [read([{ id: "c", k: "3" }], null), read([], null)]
		expect(paginateMerged(rest, next)[0].map(({ id }) => id)).toEqual(["c"])
	})

	it("refuses an anchor, which a merged list never reads a key back from", () => {
		const opts = {
			...SEALED,
			anchor: { idColumn: t.id, table: t },
			merged: {},
			parsed: parse({}),
			sortColumns: { k: t.k },
		}
		expect(() => buildDerivedListQuery(opts as never)).toThrow(
			new TypeError("a merged derived list reads no key by reference: give it idColumn, not anchor"),
		)
	})

	it("refuses a row that carries no sort field, which the merge orders by", () => {
		const built = derived({ order: "k.asc" })
		expect(() => paginateMerged([read([{ id: "a" }])], built)).toThrow(
			expect.objectContaining({
				cause: "the rows carry no k: a merged list orders by each sort field's value, so select it under its name",
				errorKey: "sort_not_wired",
			}),
		)
	})
})

/* r22 Q2: paginateMerged orders as SQLite does; a Postgres server orders numeric strings and text its own way */
describe("a merged derived list over Postgres is refused at build (Q2; sibling: a SQLite merged derived list)", () => {
	const item = pgTable("item", {
		id: pgText("id").primaryKey(),
		k: bigint("k", { mode: "bigint" }).notNull(),
		n: numeric("n").notNull(),
	})
	const refusal = new TypeError(
		"a merged list is merged in memory as SQLite orders, but Postgres orders numeric text and collated text on the server, which no in-memory merge can know: merge a SQLite list, or page this one on its server",
	)
	const build = (sortColumns: Record<string, SQL>, extra: { dialect?: "postgres" } = {}) =>
		buildDerivedListQuery({
			...SEALED,
			...extra,
			idColumn: sql`${item.id}`,
			merged: {},
			parsed: parse({ order: "k.asc" }),
			sortColumns: sortColumns as never,
		})

	it.each([
		["a numeric column", { k: sql`${item.n}` }],
		["a bigint read through an expression", { k: sql`${item.k}` }],
	])("refuses %s", (_label, sortColumns) => {
		expect(() => build(sortColumns)).toThrow(refusal)
	})

	it("refuses a list of expressions stated as Postgres", () => {
		expect(() =>
			buildDerivedListQuery({
				...SEALED,
				dialect: "postgres",
				idColumn: sql`id`,
				merged: {},
				parsed: parse({}),
				sortColumns: { k: sql`k` },
			}),
		).toThrow(refusal)
	})

	it("still builds a SQLite merged derived list", () => {
		expect(derived({ order: "k.asc" }).pagination.merged).toBe(true)
	})
})

/* r18 Q3: the merge reads its order from the rows, so a merged list orders by columns, and breaks ties by an id */
describe("buildListQuery's merged list, refused at build", () => {
	const computed = createListQuerySchema({ sort: ["@len"] })
	const keyed = sqliteTable("keyed", { k: text("k") })

	it("refuses a computed sort, which no row carries for the merge to read", () => {
		expect(() =>
			buildListQuery({
				...SEALED,
				computedSorts: { "@len": () => sql`length(k)` },
				merged: {},
				parsed: computed.parse({ order: "@len.asc" }),
				table: t,
			}),
		).toThrow(
			expect.objectContaining({
				cause: "a merged list orders by values paginateMerged reads from the rows: sort it by columns only, not @len",
				errorKey: "sort_not_wired",
			}),
		)
	})

	it("refuses a table with no id, which breaks ties across shards", () => {
		expect(() => buildListQuery({ ...SEALED, merged: {}, parsed: parse({}), table: keyed })).toThrow(
			expect.objectContaining({
				cause: 'a merged list needs an "id" column to break ties across shards, and this table has none',
				errorKey: "sort_not_wired",
			}),
		)
	})
})

const past = (cause: string): unknown => expect.objectContaining({ cause, status: 400 })

/* r18 Q16: a limit no schema bounded is held to the default cap, and maxRowsPerShard to a whole number from 1 */
describe("the bounds a list is made under", () => {
	it("refuses a hand-made limit past the default maxLimit, and takes the schema's own", () => {
		const { limitBound: _dropped, ...unbranded } = parse({})
		const parsed = { ...unbranded, limit: 1_000_000_000 }
		expect(() => buildListQuery({ ...SEALED, parsed, table: t })).toThrow(
			expect.objectContaining({
				cause: "limit 1000000000 is past 100; page by cursor, or bound it in the list schema",
				status: 400,
			}),
		)
		const wide = createListQuerySchema({ pagination: { maxLimit: 500 }, sort: ["k"] }).parse({ limit: "500" })
		expect(() => buildListQuery({ ...SEALED, parsed: wide, table: t })).not.toThrow()
	})

	/* C7 of r19: the brand is the bound itself, so a parsed query with a field changed is held to it */
	it("holds a spread or a mutated parsed query to the bound of the schema that parsed it", () => {
		expect(() => buildListQuery({ ...SEALED, parsed: { ...parse({}), limit: 1e9 }, table: t })).toThrow(
			past("limit 1000000000 is past 10; page by cursor, or bound it in the list schema"),
		)
		const wide = createListQuerySchema({ pagination: { maxLimit: 500 }, sort: ["k"] }).parse({})
		expect(() => buildListQuery({ ...SEALED, parsed: { ...wide, limit: 300 }, table: t })).not.toThrow()
		expect(() => buildListQuery({ ...SEALED, parsed: { ...wide, limit: 501 }, table: t })).toThrow(
			past("limit 501 is past 500; page by cursor, or bound it in the list schema"),
		)
		const mutated = parse({})
		mutated.limit = 11
		expect(() => buildListQuery({ ...SEALED, parsed: mutated, table: t })).toThrow(
			past("limit 11 is past 10; page by cursor, or bound it in the list schema"),
		)
		expect(() => buildListQuery({ ...SEALED, parsed: { ...parse({}), page: 1e7 }, table: t })).toThrow(
			expect.objectContaining({ errorKey: "page_too_deep", status: 400 }),
		)
		const deep = createListQuerySchema({ pagination: { maxPage: 20_000 }, sort: ["k"] }).parse({})
		expect(() => buildListQuery({ ...SEALED, parsed: { ...deep, page: 20_000 }, table: t })).not.toThrow()
		expect(() => buildListQuery({ ...SEALED, parsed: { ...deep, page: 20_001 }, table: t })).toThrow(
			expect.objectContaining({ cause: "page 20001 is past 20000; page further by cursor" }),
		)
	})

	it.each([Number.NaN, 0, -1, 1.5, Number.POSITIVE_INFINITY])(
		"refuses maxRowsPerShard %d when the list is made",
		(max) => {
			expect(() => merged({ order: "k.asc" }, max)).toThrow(
				new TypeError(`merged.maxRowsPerShard ${max} is not a whole number from 1`),
			)
		},
	)
})

/* QL4 of r22b: buildListQuery reads its dialect from its table, so 7.6's refusal holds there too */
describe("a merged table list over Postgres is refused at build (QL4; sibling: Q2's derived list above)", () => {
	const item = pgTable("item", { id: pgText("id").primaryKey(), k: numeric("k").notNull() })

	it("refuses buildListQuery with merged over a Postgres table", () => {
		expect(() =>
			buildListQuery({ ...SEALED, merged: {}, parsed: parse({ order: "k.asc" }), table: item as never }),
		).toThrow(
			new TypeError(
				"a merged list is merged in memory as SQLite orders, but Postgres orders numeric text and collated text on the server, which no in-memory merge can know: merge a SQLite list, or page this one on its server",
			),
		)
	})
})
