/**
 * Q2 of r20: a merged derived list over a UNION ALL, its sort key and tiebreak expressions with no
 * column (the invite inbox's shape), on libsql shards in `intMode: "string"`, which reads every
 * INTEGER as a decimal string. The merge compares each key as SQLite stored it, so integers whose
 * text order differs from their number order page as one database orders them, by cursor and by page.
 */
import { type Client, createClient } from "@libsql/client"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/libsql"
import { afterEach, describe, expect, it } from "vitest"
import { SEALED } from "../../../src/query/__fixtures__/cursor-secret.ts"
import { paginateMerged } from "../../../src/query/merged.ts"
import { createListQuerySchema } from "../../../src/query/schema.ts"
import { applyListQuery, buildDerivedListQuery } from "../../../src/query/sqlite/build-list-query.ts"

const schema = createListQuerySchema({ pagination: { defaultLimit: 2, maxLimit: 2 }, sort: ["created_at"] })
const inbox = (name: string) => sql`${sql.identifier("inbox")}.${sql.identifier(name)}`
const UNION = sql`(SELECT id, created_at FROM org_invite UNION ALL SELECT id, created_at FROM project_invite) AS ${sql.identifier("inbox")}`

/* [shard, table, id, created_at]: as text "100" < "12" < "25" < "3" < "40" < "7", and the ids as text "100" < "12" < "25" < "3" */
const KEYS: Array<[number, string, number, number]> = [
	[0, "org_invite", 1, 3],
	[1, "org_invite", 2, 12],
	[0, "project_invite", 4, 25],
	[1, "project_invite", 5, 100],
	[0, "org_invite", 6, 7],
	[1, "project_invite", 8, 40],
]
/* one created_at, so only the tiebreak orders them */
const TIES: Array<[number, string, number, number]> = [
	[0, "org_invite", 3, 5],
	[1, "org_invite", 12, 5],
	[0, "project_invite", 100, 5],
	[1, "project_invite", 25, 5],
]

let clients: Client[] = []
afterEach(() => {
	for (const client of clients) client.close()
	clients = []
})

async function open(): Promise<Client> {
	const client = createClient({ intMode: "string", url: ":memory:" })
	clients.push(client)
	await client.executeMultiple(
		"CREATE TABLE org_invite (id INTEGER PRIMARY KEY, created_at INTEGER); CREATE TABLE project_invite (id INTEGER PRIMARY KEY, created_at INTEGER);",
	)
	return client
}

/** The two shards and one database holding every row, `rows` spread over the shards */
async function seed(rows: typeof KEYS) {
	const [shards, one] = [[await open(), await open()], await open()]
	for (const [shard, table, id, at] of rows)
		for (const client of [shards[shard] as Client, one])
			await client.execute({ args: [id, at], sql: `INSERT INTO ${table} VALUES (?, ?)` })
	return { one, shards }
}

const read = (client: Client, built: never) =>
	applyListQuery(
		(extras) =>
			drizzle({ client })
				.select({
					created_at: sql`${inbox("created_at")}`.as("created_at"),
					id: sql`${inbox("id")}`.as("id"),
					...extras,
				})
				.from(UNION),
		built,
	) as unknown as Promise<Array<{ id: string }>>

/** Every id the merged list pages under `order`, by cursor or by page; at most twelve pages */
async function pageAll(shards: Client[], order: string, mode: "cursor" | "page"): Promise<string[]> {
	const seen: string[] = []
	let cursor: string | undefined
	for (let p = 1; p <= 12; p++) {
		const parsed = schema.parse({ order, ...(mode === "cursor" ? { cursor } : { page: String(p) }) })
		const built = buildDerivedListQuery({
			...SEALED,
			idColumn: inbox("id"),
			merged: {},
			parsed,
			sortColumns: { created_at: inbox("created_at") },
		})
		const [items, meta] = paginateMerged(await Promise.all(shards.map((client) => read(client, built as never))), built)
		seen.push(...items.map((row) => String(row.id)))
		if (mode === "cursor" ? meta.nextCursor === null : !meta.hasMore) break
		cursor = meta.nextCursor ?? undefined
	}
	return seen
}

describe("a merged derived list over expressions, on libsql shards in intMode string", () => {
	for (const [name, rows] of [
		["sort key", KEYS],
		["tiebreak", TIES],
	] as const)
		it.each(["created_at.asc", "created_at.desc"])(
			`pages %s by its ${name} as one database orders it`,
			async (order) => {
				const { one, shards } = await seed(rows)
				const direction = order.endsWith("desc") ? "DESC" : "ASC"
				const truth = (
					await one.execute(
						`SELECT id FROM (SELECT id, created_at FROM org_invite UNION ALL SELECT id, created_at FROM project_invite) ORDER BY created_at ${direction}, id ${direction}`,
					)
				).rows.map((row) => String(row["id"]))
				for (const mode of ["cursor", "page"] as const) expect(await pageAll(shards, order, mode), mode).toEqual(truth)
			},
		)
})
