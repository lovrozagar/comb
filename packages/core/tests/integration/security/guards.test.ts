/**
 * The adversarial suite: one hostile input per comb guard, run on real engines. The mutation
 * harness (tests/structure/mutation-harness.ts) reruns this file with each guard disabled and
 * requires it to go red, so every case here is the reason its guard exists.
 */
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/d1"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { afterEach, describe, expect, it, vi } from "vitest"
import { guardModule, guardNamed } from "../../structure/mutation-harness.ts"
import { d1Memory, type D1Harness } from "../support/d1.ts"
import { libsqlMemory } from "../support/libsql.ts"
import { SEALED } from "../../../src/query/__fixtures__/cursor-secret.ts"

const mutant = guardNamed(process.env["COMB_MUTANT"])
if (mutant !== undefined) {
	vi.doMock(guardModule(mutant), async (importOriginal) => {
		const original = await importOriginal<Record<string, unknown>>()
		return { ...original, ...mutant.disable(original) }
	})
}

/* imported after the mock, so a mutant reaches every module that uses the guard */
const { buildListQuery } = await import("../../../src/query/sqlite/build-list-query.ts")
const { createCursor } = await import("../../../src/query/cursor-mint.ts")
const { buildFtsWhere } = await import("../../../src/query/sqlite/search.ts")
const { sqliteErrorHandler } = await import("../../../src/sqlite/constraint-handler.ts")
const { d1ErrorHandler } = await import("../../../src/sqlite/d1/error-handler.ts")
const { ShardRouter } = await import("../../../src/sqlite/d1/sharding/router.ts")

const event = sqliteTable("event", {
	id: text("id").primaryKey(),
	secret: text("secret"),
	seen_at: integer("seen_at", { mode: "timestamp_ms" }),
})

/** What `run` threw, or the string "nothing" */
async function thrown(run: () => unknown): Promise<unknown> {
	try {
		await run()
	} catch (error) {
		return error
	}
	return "nothing"
}

describe("list queries", () => {
	it("refuse a filter or an order no schema checked, which would reach any column (S-M8)", () => {
		const secret = {
			root: {
				conditions: [{ field: "secret", operator: "like" as const, value: "a*" }],
				logic: "and" as const,
				subgroups: [],
			},
		}
		expect(() =>
			buildListQuery({ ...SEALED, parsed: { filterAst: secret, limit: 5, parsedSort: [] }, table: event }),
		).toThrow(expect.objectContaining({ errorKey: "filter_not_wired" }))
		const bySecret = [{ direction: "asc" as const, field: "secret" }]
		expect(() =>
			buildListQuery({ ...SEALED, parsed: { filterAst: null, limit: 5, parsedSort: bySecret }, table: event }),
		).toThrow(expect.objectContaining({ errorKey: "sort_not_wired" }))
	})

	it("refuse a filter on a field nothing resolves, rather than list every row (filter-fail-closed)", () => {
		const filterAst = {
			root: {
				conditions: [{ field: "nope", operator: "eq" as const, value: "x" }],
				logic: "and" as const,
				subgroups: [],
			},
		}
		expect(() =>
			buildListQuery({ ...SEALED, parsed: { filterAst, limit: 5, parsedSort: [], validated: true }, table: event }),
		).toThrow(expect.objectContaining({ errorKey: "filter_not_wired" }))
	})

	it("refuse a forged cursor whose value is not its column's type (cursor-value-type)", () => {
		const parsedSort = [{ direction: "desc" as const, field: "seen_at" }]
		const cursor = createCursor({ id: "e1", seen_at: "2024" }, parsedSort, SEALED)
		expect(() =>
			buildListQuery({
				...SEALED,
				parsed: { cursor, filterAst: null, limit: 5, parsedSort, validated: true },
				table: event,
			}),
		).toThrow(expect.objectContaining({ errorKey: "invalid_cursor", status: 400 }))
	})
})

describe("cursors a client writes itself, or carries to another tenant (cursor-seal)", () => {
	const staff = sqliteTable("staff", { id: text("id").primaryKey(), name: text("name"), salary: integer("salary") })

	it("refuse a cursor whose guessed salary would list who earns more, on a sort the client cannot select", async () => {
		const { client, close, db } = libsqlMemory()
		try {
			await client.execute("CREATE TABLE staff (id TEXT PRIMARY KEY, name TEXT, salary INTEGER)")
			await client.execute("INSERT INTO staff VALUES ('s1', 'ann', 73519), ('s2', 'bob', 50000)")
			const parsedSort = [{ direction: "asc" as const, field: "salary" }]
			const guess = { i: "", s: "salary.asc.nullslast", v: [73518] }
			/* the payload a cursor seals, written by the client as base64url JSON with no seal */
			const body = btoa(JSON.stringify(guess)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_")
			const run = async () => {
				const built = buildListQuery({
					...SEALED,
					parsed: { cursor: body, filterAst: null, limit: 5, parsedSort, validated: true },
					table: staff,
				})
				return db.select({ id: staff.id }).from(staff).where(built.where).all()
			}
			expect(await thrown(run)).toMatchObject({ errorKey: "invalid_cursor", status: 400 })
		} finally {
			close()
		}
	})

	it("refuse a cursor minted in one tenant's list and replayed in another's (R2)", () => {
		const parsedSort = [{ direction: "asc" as const, field: "salary" }]
		const minted = createCursor({ id: "s9", salary: 73518 }, parsedSort, { ...SEALED, cursorScope: "staff:org_a" })
		const replay = () =>
			buildListQuery({
				...SEALED,
				cursorScope: "staff:org_b",
				parsed: { cursor: minted, filterAst: null, limit: 5, parsedSort, validated: true },
				table: staff,
			})
		expect(replay).toThrow(expect.objectContaining({ errorKey: "invalid_cursor", status: 400 }))
	})
})

describe("raw SQL identifiers (raw-sql-quoting)", () => {
	it("keep a double quote in a table name inside the identifier", async () => {
		const { client, close, db } = libsqlMemory()
		try {
			const name = 'notes"_fts'
			await client.execute(`CREATE TABLE notes (id TEXT PRIMARY KEY)`)
			await client.execute(`INSERT INTO notes VALUES ('n1')`)
			await client.execute(`CREATE VIRTUAL TABLE "notes""_fts" USING fts5(body)`)
			await client.execute(
				`INSERT INTO "notes""_fts" (rowid, body) VALUES ((SELECT rowid FROM notes WHERE id = 'n1'), 'hello world')`,
			)
			const where = buildFtsWhere({ ftsTable: name, table: sqliteTable("notes", { id: text("id") }) }, "hello")
			const rows = await db.all(sql`SELECT id FROM notes WHERE ${where}`)
			expect(rows).toEqual([{ id: "n1" }])
		} finally {
			close()
		}
	})
})

describe("error classification", () => {
	it("reads the engine's code, not a failed query's params that spell a constraint (constraint-classification)", async () => {
		const { client, close, db } = libsqlMemory()
		try {
			await client.execute("CREATE TABLE member (id TEXT PRIMARY KEY)")
			const forged = "x: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)"
			const failure = await thrown(() => db.run(sql`SELECT nope FROM member WHERE id = ${forged}`))
			const maps = [
				{ member: { unique: { id: { cause: "taken", errorKey: "member_id_taken", statusKey: "conflict" as const } } } },
			]
			expect(() => sqliteErrorHandler(failure, maps)).not.toThrow()
		} finally {
			close()
		}
	})

	describe("on D1", () => {
		let harness: D1Harness | undefined
		afterEach(async () => {
			await harness?.dispose()
			harness = undefined
		})

		it("reports a bad query as a 500 even when its params say reset (transient-classification)", async () => {
			harness = await d1Memory()
			await harness.CORE.exec("CREATE TABLE member (id TEXT PRIMARY KEY)")
			const db = drizzle(harness.CORE)
			const failure = await thrown(() =>
				db.run(sql`SELECT reset_at FROM member WHERE id = ${"please reset my account"}`),
			)
			expect(await thrown(() => d1ErrorHandler(failure, []))).toMatchObject({
				errorKey: "database_io_error",
				status: 500,
			})
		})

		it("gives two first requests for one org the same shard, neither failing (shard-upsert)", async () => {
			harness = await d1Memory()
			await harness.CORE.exec(
				"CREATE TABLE shard_map (created_at integer NOT NULL DEFAULT (unixepoch() * 1000), deleted_at integer, driver text NOT NULL DEFAULT 'd1', org_id text PRIMARY KEY, shard_id integer NOT NULL, target text NOT NULL, updated_at integer NOT NULL DEFAULT (unixepoch() * 1000))",
			)
			const deps = { coreDb: harness.CORE, kv: harness.KV }
			const pending: Promise<unknown>[] = []
			const ctx = { waitUntil: (promise: Promise<unknown>) => void pending.push(promise) }
			const routers = [new ShardRouter({ totalShards: 4 }), new ShardRouter({ totalShards: 4 })]
			const results = await Promise.allSettled(routers.map((router) => router.allocate("org_race", deps, ctx)))
			await Promise.allSettled(pending)
			expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"])
		})
	})
})
