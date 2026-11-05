/**
 * Round four of area B on SQLite: one sort key `k` over a column of a declared type and drizzle mode,
 * holding rows a raw writer stored, walked on every list kind by cursor at a page size, on whichever
 * driver a suite opens. SQLite itself says the order every row must come in (`ORDER BY k, id` in the
 * walk's direction), so no case spells its order by hand. AB4-1 (a cursor the list minted refused as a
 * 400), AB4-2 (stored classes drizzle's read loses) and AB4-3 (a refusal that depends on the page
 * size) each run their datasets through it on libsql, bun:sqlite and D1.
 */
import { type AnyColumn, defineRelations, eq, getTableColumns, type SQL, sql } from "drizzle-orm"
import { blob, integer, numeric, real, type SQLiteAsyncDatabase, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { queryHelpers } from "../../../src/query/drizzle.ts"
import { SEALED } from "../../../src/query/__fixtures__/cursor-secret.ts"
import { paginateMerged } from "../../../src/query/merged.ts"
import { createListQuerySchema } from "../../../src/query/schema.ts"
import { applyListQuery, buildDerivedListQuery, buildListQuery } from "../../../src/query/sqlite/build-list-query.ts"

/** The drizzle modes a case declares its key with */
const MODES = {
	blob: () => blob("k", { mode: "buffer" }),
	boolean: () => integer("k", { mode: "boolean" }),
	integer: () => integer("k"),
	json: () => text("k", { mode: "json" }),
	numeric: () => numeric("k"),
	real: () => real("k"),
	text: () => text("k"),
	timestamp: () => integer("k", { mode: "timestamp" }),
	timestamp_ms: () => integer("k", { mode: "timestamp_ms" }),
} as const

/** A key column: its declared SQL type, its drizzle mode, and the SQL literal of each row's value, ids r0, r1… */
export type StoredCase = { ddl: string; mode: keyof typeof MODES; values: readonly string[] }

/** Every list kind: the table list, a derived list anchored or not, keyed by the column or an expression over it, by a joined table's column, merged over two shards, and drizzle's relational `findMany` */
export const STORED_KINDS = [
	"table",
	"anchored",
	"anchorless",
	"expression",
	"anchored expression",
	"joined",
	"merged",
	"listOptions",
] as const
export type StoredKind = (typeof STORED_KINDS)[number]

/** The kinds that read the key back from the list's table, never binding it as drizzle read it */
export const READ_BACK: ReadonlySet<StoredKind> = new Set<StoredKind>(["table", "anchored", "listOptions"])

type Db = SQLiteAsyncDatabase<any, any>
type Row = Record<string, unknown>
/** How a suite opens one database on its driver, seeded with `statements`, its drizzle built with `relations` */
export type OpenDb = (statements: readonly string[], relations: object) => Promise<Db>

/** What a walk served: the ids in order, the pages it read, and the error that ended it */
export type StoredWalk = { error?: unknown; ids: string[]; pages: number }

/** The tables of `kase`, `post` holding the key and `metric` a joined copy of it */
function tablesOf(kase: StoredCase) {
	const post = sqliteTable("post", { id: text("id").primaryKey(), k: MODES[kase.mode]() })
	const metric = sqliteTable("metric", { k: MODES[kase.mode](), post_id: text("post_id") })
	return { metric, post, relations: defineRelations({ post }) }
}

/** The statements that seed every row of `kase`, or the half of shard `shard` of two */
function seedOf(kase: StoredCase, shard?: 0 | 1): string[] {
	const rows = kase.values
		.map((value, i) => `('r${i}', ${value})`)
		.filter((_, i) => shard === undefined || i % 2 === shard)
	return [
		`CREATE TABLE post (id TEXT PRIMARY KEY, k ${kase.ddl})`,
		`CREATE TABLE metric (post_id TEXT, k ${kase.ddl})`,
		...(rows.length > 0 ? [`INSERT INTO post VALUES ${rows.join(", ")}`] : []),
		"INSERT INTO metric SELECT id, k FROM post",
	]
}

/** Every id of `kase` in SQLite's own order of the key, then the id, in `direction` */
export async function sqliteOrder(open: OpenDb, kase: StoredCase, direction: "asc" | "desc"): Promise<string[]> {
	const db = await open(seedOf(kase), tablesOf(kase).relations)
	const rows = (await db.all(sql.raw(`SELECT id FROM post ORDER BY k ${direction}, id ${direction}`))) as unknown[]
	return rows.map((row) => (Array.isArray(row) ? row[0] : (row as { id: string }).id) as string)
}

/** The request a list of `kase` is built from */
type Parsed = Parameters<typeof queryHelpers.listOptions>[0]

/** One page of the list `kind` of `kase`, read from its databases: its rows, and the next cursor */
type Lister = (parsed: Parsed) => Promise<readonly [readonly Row[], string | null]>

/** A paginated page as a Lister returns it: its rows, and the next cursor */
const meta = ([page, { nextCursor }]: readonly [readonly Row[], { nextCursor: string | null }]) =>
	[page, nextCursor] as const

/** What reads a page of the list `kind` of `kase`, on one database seeded with it, or two shards of it for "merged" */
async function listerOf(open: OpenDb, kase: StoredCase, kind: StoredKind): Promise<Lister> {
	const { metric, post, relations } = tablesOf(kase)
	const dbs =
		kind === "merged"
			? [await open(seedOf(kase, 0), relations), await open(seedOf(kase, 1), relations)]
			: [await open(seedOf(kase), relations)]
	const [db] = dbs as [Db]
	const key: AnyColumn | SQL = kind === "joined" ? metric.k : kind.includes("expression") ? sql`${post.k}` : post.k
	const select = (on: Db) => (extras: object) =>
		kind === "joined"
			? on
					.select({ id: post.id, k: metric.k, ...extras })
					.from(post)
					.innerJoin(metric, eq(metric.post_id, post.id))
			: on.select({ ...getTableColumns(post), k: key, ...extras }).from(post)
	const rows = async (on: Db, list: object) =>
		await (applyListQuery(select(on) as never, list as never) as unknown as Promise<Row[]>)
	if (kind === "listOptions") {
		const relational = db as unknown as {
			query: { post: { findMany: (options: never) => Promise<Row[]> } }
		}
		return async (parsed) => {
			const options = queryHelpers.listOptions(parsed, SEALED)
			return meta(queryHelpers.paginate(await relational.query.post.findMany(options as never), options))
		}
	}
	if (kind === "merged") {
		return async (parsed) => {
			const list = buildListQuery({ ...SEALED, merged: {}, parsed, table: post })
			return meta(paginateMerged(await Promise.all(dbs.map(async (on) => await rows(on, list))), list))
		}
	}
	return async (parsed) => {
		const list =
			kind === "table"
				? buildListQuery({ ...SEALED, parsed, table: post })
				: buildDerivedListQuery({
						...SEALED,
						...(kind === "anchorless" || kind === "expression"
							? { idColumn: post.id }
							: { anchor: { idColumn: post.id, table: post } }),
						parsed,
						sortColumns: { k: key },
					})
		return meta(queryHelpers.paginate(await rows(db, list), list))
	}
}

/**
 * Every id the list `kind` serves of `kase`, `limit` a page `direction`, by cursor, until the list ends,
 * an error ends it, or twice the rows' pages pass without an end (a loop)
 */
export async function walkStored(
	open: OpenDb,
	kase: StoredCase,
	{ direction, kind, limit }: { direction: "asc" | "desc"; kind: StoredKind; limit: number },
): Promise<StoredWalk> {
	const list = await listerOf(open, kase, kind)
	const schema = createListQuerySchema({ pagination: { defaultLimit: limit, maxLimit: limit }, sort: ["k"] })
	const ids: string[] = []
	let cursor: string | undefined
	let pages = 0
	try {
		while (pages < kase.values.length * 2 + 2) {
			pages++
			const [page, next] = await list({ ...schema.parse({ order: `k.${direction}` }), cursor })
			ids.push(...page.map((row) => row["id"] as string))
			if (next === null) return { ids, pages }
			cursor = next
		}
	} catch (error) {
		return { error, ids, pages }
	}
	return { ids, pages }
}

/** Whether `ids` is a start of `order`: what a walk a 500 ended served before it */
export const startsWith = (ids: readonly string[], order: readonly string[]): boolean =>
	ids.length <= order.length && ids.every((id, i) => order[i] === id)

/** Whether `error` is the documented 500 naming the key */
const namesKey = (error: unknown): boolean =>
	typeof error === "object" &&
	error !== null &&
	(error as { errorKey?: unknown }).errorKey === "sort_not_wired" &&
	(error as { status?: unknown }).status === 500 &&
	String((error as { cause?: unknown }).cause).includes("k")

/**
 * What breaks the rule every walk of `kase` keeps, on every kind, both directions, each of `limits`: a
 * list that reads the key back serves every row once in SQLite's order; one that binds it as read
 * serves every row once or answers the documented 500, having served a start of that order (`refusing`
 * widens which may). Never a
 * 400, a repeat, a skip or a loop. One line a broken walk, so an empty list is a pass
 */
export async function storedProblems(
	open: OpenDb,
	kase: StoredCase,
	{
		kinds = STORED_KINDS,
		limits = [1, 2, 3],
		refusing = (kind) => !READ_BACK.has(kind),
	}: {
		kinds?: readonly StoredKind[]
		limits?: readonly number[]
		/** the kinds that may answer the 500; by default those that bind the key as read */
		refusing?: (kind: StoredKind) => boolean
	} = {},
): Promise<string[]> {
	const problems: string[] = []
	for (const direction of ["asc", "desc"] as const) {
		const order = await sqliteOrder(open, kase, direction)
		for (const kind of kinds)
			for (const limit of limits) {
				const walk = await walkStored(open, kase, { direction, kind, limit })
				const refused = walk.error !== undefined && refusing(kind) && namesKey(walk.error)
				const fine = refused
					? startsWith(walk.ids, order)
					: walk.error === undefined && walk.ids.join() === order.join()
				if (!fine)
					problems.push(
						`${kind} ${direction} limit ${limit}: served ${walk.ids.join(",")} of ${order.join(",")} in ${walk.pages} pages${walk.error === undefined ? "" : `, then ${errorLine(walk.error)}`}`,
					)
			}
	}
	return problems
}

/** An error as a problem line names it */
function errorLine(error: unknown): string {
	const { cause, errorKey, message, status } = error as {
		cause?: unknown
		errorKey?: string
		message?: string
		status?: number
	}
	return `${errorKey ?? "error"} ${status ?? ""}: ${String(cause ?? message).slice(0, 120)}`
}

/**
 * The first page of the list `kind` serves of `kase`, `limit` a page `direction`, and the page a walk
 * ended on with an error: AB4-3's check that a refused row is refused on the page that serves it, at
 * any page size
 */
export async function refusedOnPage(
	open: OpenDb,
	kase: StoredCase,
	walk: { direction: "asc" | "desc"; kind: StoredKind; limit: number },
): Promise<{ error?: string; ids: string[]; page: number }> {
	const { error, ids, pages } = await walkStored(open, kase, walk)
	return {
		...(error === undefined ? {} : { error: namesKey(error) ? "sort_not_wired" : errorLine(error) }),
		ids,
		page: pages,
	}
}

/* AB4-1 of area B: a JSON-mode key, which no cursor reads back as itself, on both dialects a 500 */
export const JSON_TEXT: StoredCase = { ddl: "TEXT", mode: "json", values: [`'"a"'`, `'"b"'`, `'"c"'`] }
/* AB4-1: a number column holding TEXT, which SQLite orders after every number and compares exactly */
export const REAL_TEXT: StoredCase = { ddl: "REAL", mode: "real", values: ["1", "2", "'t'", "3"] }
export const INTEGER_TEXT: StoredCase = { ddl: "INTEGER", mode: "integer", values: ["1", "2", "'x'", "3"] }
/* AB4-1: a numeric-looking TEXT in a column of no declared type, whose BLOB affinity keeps a bound string a string */
export const UNTYPED_TEXT: StoredCase = { ddl: "", mode: "real", values: ["1", "2", "'1.5'", "3"] }
/* AB4-1: a TEXT column holding a BLOB, which drizzle reads as the text of its bytes */
export const TEXT_BLOB: StoredCase = { ddl: "TEXT", mode: "text", values: ["'a'", "x'61'", "'b'"] }

/* AB4-2 of area B: stored classes outside what each mode reads back as stored */
export const STORED_CLASSES: Record<string, StoredCase> = {
	"blob() holding TEXT": { ddl: "BLOB", mode: "blob", values: ["x'00'", "'a'", "x'01'", "'b'"] },
	"integer() over a TEXT column holding digits": { ddl: "TEXT", mode: "integer", values: ["1", "2", "'3'", "'10'"] },
	"numeric() holding a BLOB": { ddl: "NUMERIC", mode: "numeric", values: ["1", "x'01'", "x'02'", "2"] },
	"numeric() holding ±Infinity": { ddl: "NUMERIC", mode: "numeric", values: ["1", "9e999", "2", "-9e999"] },
	"timestamp_ms holding a BLOB and a value past a Date's range": {
		ddl: "INTEGER",
		mode: "timestamp_ms",
		values: ["1000", "8640000000000002", "x'02'", "0"],
	},
}

/* AB4-3 of area B: a key past the cap between two short ones, 'p'… sorting first descending */
export const LONG_BETWEEN: StoredCase = { ddl: "TEXT", mode: "text", values: ["'a'", `'${"p".repeat(9000)}b'`, "'c'"] }
/* AB4-3: a JSON object among JSON strings, which no cursor carries */
export const JSON_OBJECT: StoredCase = { ddl: "TEXT", mode: "json", values: [`'"a"'`, `'{"b":1}'`, `'"c"'`] }
/* AB4-3: a timestamp BLOB libsql reads as an Invalid Date, after both numbers ascending */
export const TIMESTAMP_BLOB: StoredCase = {
	ddl: "INTEGER",
	mode: "timestamp_ms",
	values: ["1000", "x'01'", "x'02'", "2000"],
}

/* AB4-7 of area B: REALs a key's mode reads apart, past where D1's printf reads back and below, carried as a text of them that reads back */
export const HELD_REALS: Record<string, StoredCase> = {
	"boolean holding REALs": { ddl: "INTEGER", mode: "boolean", values: ["0", "1e300", "1", "1e-300", "2.5"] },
	"text() over an untyped column holding REALs": {
		ddl: "",
		mode: "text",
		values: ["'a'", "1e300", "1e-300", "'b'", "1000"],
	},
}
/* AB4-7: a REAL no text D1 prints of reads back as, which libsql and bun:sqlite print exactly; drizzle's blob mode reads no REAL */
export const HELD_UNPRINTED: StoredCase = { ddl: "", mode: "text", values: ["1000", "7.0631582885980606e300", "2000"] }
