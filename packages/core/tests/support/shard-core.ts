/** Miniflare's D1 and a memory KV for the shard router's Miniflare suites: placement and its races. */
import type { D1Database } from "@cloudflare/workers-types"
import { Miniflare } from "miniflare"
import type { ShardKv } from "../../src/sqlite/d1/sharding/types.ts"

export const SHARD_MAP_DDL =
	"CREATE TABLE shard_map (created_at integer NOT NULL DEFAULT (unixepoch() * 1000), deleted_at integer, driver text NOT NULL DEFAULT 'd1', org_id text PRIMARY KEY, shard_id integer NOT NULL, target text NOT NULL, updated_at integer NOT NULL DEFAULT (unixepoch() * 1000))"
const WORKER = "export default { fetch() { return new Response(null, { status: 204 }) } }"

/** A KV that keeps what it is given */
export function memoryKv(): ShardKv {
	const store = new Map<string, string>()
	return {
		delete: async (key) => void store.delete(key),
		get: async (key) => (store.has(key) ? JSON.parse(store.get(key) as string) : null),
		put: async (key, value) => void store.set(key, value),
	}
}

/** `store` whose reads see what it holds, then wait for `release` before they answer: a fill's read held across an invalidate */
export function readThenWait(store: ShardKv): { kv: ShardKv; release: () => void } {
	const gated: { release: () => void } = { release: () => undefined }
	const gate = new Promise<void>((resolve) => (gated.release = resolve))
	const kv: ShardKv = {
		...store,
		get: async (key, type) => {
			const held = await store.get(key, type)
			await gate
			return held
		},
	}
	return { kv, release: () => gated.release() }
}

/** Miniflare holding a core database with `rows` ([org, shard]) in shard_map, and one more for a lagging replica */
export async function openCore(rows: Array<[string, number]> = []) {
	const mf = new Miniflare({ d1Databases: ["CORE", "LAG"], kvNamespaces: ["KV"], modules: true, script: WORKER })
	const primary = (await mf.getD1Database("CORE")) as unknown as D1Database
	const replica = (await mf.getD1Database("LAG")) as unknown as D1Database
	for (const db of [primary, replica]) await db.exec(SHARD_MAP_DDL)
	for (const [org, shard] of rows)
		await primary
			.prepare("INSERT INTO shard_map (org_id, shard_id, target) VALUES (?, ?, ?)")
			.bind(org, shard, String(shard))
			.run()
	return { mf, primary, replica }
}

/**
 * A core database whose primary is `primary` and whose replica is `replica`, as D1 sessions reach
 * them: a `first-unconstrained` session reads the replica, any other the primary; each read counted
 */
export function replicated(primary: D1Database, replica: D1Database) {
	const reads = { primary: 0, replica: 0 }
	const sessionOf = (db: D1Database, tier: keyof typeof reads) => ({
		batch: (statements: unknown) => db.batch(statements as never),
		getBookmark: () => "bk",
		prepare: (query: string) => {
			reads[tier]++
			return db.prepare(query)
		},
	})
	const coreDb = {
		batch: (statements: unknown) => primary.batch(statements as never),
		prepare: (query: string) => primary.prepare(query),
		withSession: (constraint: string) =>
			constraint === "first-unconstrained" ? sessionOf(replica, "replica") : sessionOf(primary, "primary"),
	} as unknown as D1Database
	return { coreDb, reads }
}

/**
 * `db` whose statements answer, then wait for `gate`: a core read that lands before a remap and
 * returns after it; `answered` settles once one has answered
 */
export function readsThenWaits(db: D1Database, gate: Promise<void>): { coreDb: D1Database; answered: Promise<void> } {
	const signal: { answer: () => void } = { answer: () => undefined }
	const answered = new Promise<void>((resolve) => (signal.answer = resolve))
	const held = <T extends object>(statement: T): T =>
		new Proxy(statement, {
			get(target, prop) {
				const value = Reflect.get(target, prop) as unknown
				if (typeof value !== "function") return value
				if (prop === "bind") return (...args: unknown[]) => held(value.apply(target, args) as object)
				return async (...args: unknown[]) => {
					const result = await value.apply(target, args)
					signal.answer()
					await gate
					return result
				}
			},
		})
	const coreDb = {
		prepare: (query: string) => held(db.prepare(query)),
		withSession: () => ({ getBookmark: () => "bk", prepare: (query: string) => held(db.prepare(query)) }),
	} as unknown as D1Database
	return { answered, coreDb }
}
