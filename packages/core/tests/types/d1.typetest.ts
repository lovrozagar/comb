/**
 * K3 of r21: comb's D1 modules type a binding by the methods they call, so `wrangler types`'
 * globals and `@cloudflare/workers-types` both fit, and a session comes back in the binding's own
 * type, which drizzle() takes. Checked by `bun run typecheck`; nothing here runs.
 */
import type { D1Database, D1DatabaseSession, D1PreparedStatement, KVNamespace } from "@cloudflare/workers-types"
import { drizzle } from "drizzle-orm/d1"
import { expectTypeOf } from "vitest"
import { BookmarkTracker } from "../../src/sqlite/d1/bookmark.ts"
import type { D1DatabaseLike, D1SessionLike } from "../../src/sqlite/d1/d1-types.ts"
import { openD1Session } from "../../src/sqlite/d1/session.ts"
import type { D1DatabaseLike as SessionBound, SessionOf } from "../../src/sqlite/d1/session.ts"
import type { D1DatabaseLike as ShardBound } from "../../src/sqlite/d1/sharding/index.ts"
import { ShardRouter } from "../../src/sqlite/d1/sharding/router.ts"
import type { ShardKv, ShardMapping } from "../../src/sqlite/d1/sharding/types.ts"

declare const db: D1Database
declare const kv: ShardKv
declare const statement: D1PreparedStatement

/* the caller's binding and its session, as the caller typed them */
expectTypeOf(openD1Session(db).client).toEqualTypeOf<D1Database | D1DatabaseSession>()
expectTypeOf(openD1Session(db).session).toEqualTypeOf<D1DatabaseSession | undefined>()

/* the structural bound takes a binding with no sessions, and refuses what is no D1 binding */
declare const bare: Omit<D1DatabaseLike, "withSession">
expectTypeOf(openD1Session(bare).client).toEqualTypeOf<Omit<D1DatabaseLike, "withSession"> | D1SessionLike>()
// @ts-expect-error a string is no D1 database
openD1Session("not a database")

new BookmarkTracker().track(openD1Session(db).session, "core")
// @ts-expect-error a binding is no session: it has no bookmark
new BookmarkTracker().track(db, "core")

/* the router takes the caller's binding and statements */
const router = new ShardRouter({ totalShards: 1 })
void router.move({ orgId: "o", shardId: 0, with: [statement] }, { coreDb: db, kv }, { waitUntil: () => {} })

/* K2 of r22: a shard's handle is the type the env holds it as, which `wrangler types` writes */
interface Env {
	KV: KVNamespace
	SHARD_DB_0: D1Database
	SHARD_DB_1: D1Database
}
declare const env: Env
declare const mapping: ShardMapping
expectTypeOf(router.getHandle(mapping, env).handle).toEqualTypeOf<D1Database>()
drizzle(router.getHandle(mapping, env).handle)

/* AD1: `wrangler types` writes a binding bound in only some environments as optional; the router throws on an absent one at run time */
interface StagingEnv {
	KV: KVNamespace
	SHARD_DB_0: D1Database
	SHARD_DB_1?: D1Database
}
declare const staging: StagingEnv
expectTypeOf(router.getHandle(mapping, staging).handle).toEqualTypeOf<D1Database>()

/* an env typed by a string index signature of no binding names none, so the handle is the structural one */
declare const indexed: Record<string, unknown>
expectTypeOf(router.getHandle(mapping, indexed).handle).toEqualTypeOf<D1DatabaseLike>()
/* one whose index holds D1 bindings names their type (AD14 of the area D review) */
declare const bindings: Record<string, D1Database>
expectTypeOf(router.getHandle(mapping, bindings).handle).toEqualTypeOf<D1Database>()
declare const some: Partial<Record<string, D1Database>>
expectTypeOf(router.getHandle(mapping, some).handle).toEqualTypeOf<D1Database>()
/* D2-5 of the area D round-two review: one whose index provably holds no D1 binding is refused */
declare const strings: Record<string, string>
// @ts-expect-error an index of strings holds no D1 binding
router.getHandle(mapping, strings)
declare const kvs: Record<string, KVNamespace>
// @ts-expect-error an index of KV namespaces holds no D1 binding
router.getHandle(mapping, kvs)

/* an env whose known keys hold no shard binding, or a shard key holding what is no D1 binding, is refused */
interface NoShards {
	DB: D1Database
	KV: KVNamespace
}
declare const noShards: NoShards
// @ts-expect-error an env with no SHARD_DB_* binding holds no shard
router.getHandle(mapping, noShards)
// @ts-expect-error a shard key holds a D1 binding
router.getHandle(mapping, { KV: {} as KVNamespace, SHARD_DB_0: "core" })
interface NamedShard {
	KV: KVNamespace
	SHARD_DB_0: string
}
declare const named: NamedShard
// @ts-expect-error a shard key holds a D1 binding, in an env no literal gives
router.getHandle(mapping, named)

/* AD14 of the area D review: a consumer's helper generic over its env gets the binding its bound names */
function shardOf<E extends { SHARD_DB_0: D1Database }>(given: E): D1Database {
	return router.getHandle(mapping, given).handle
}
expectTypeOf(shardOf(env)).toEqualTypeOf<D1Database>()

/*
 * D2-1, D2-2 and D2-9 of the area D round-two review: a helper generic over an interface env, as
 * `wrangler types` writes one, gets the binding shard 0 holds, and no env that holds no shard
 * binding compiles, an empty or generic one included (the review's P1-P13 and x1-x4)
 */
interface IEnv {
	DB: D1Database
	SHARD_DB_0: D1Database
	SHARD_DB_1: D1Database
}
type TEnv = { DB: D1Database; SHARD_DB_0: D1Database; SHARD_DB_1: D1Database }
declare const ienv: IEnv
declare const tenv: TEnv
/* wrangler types names it Cloudflare.Env, which this file's own Env would shadow */
declare namespace Cloudflare {
	interface WorkerEnv {
		SHARD_DB_0: D1Database
		SHARD_DB_1?: D1Database
	}
}
interface WranglerEnv extends Cloudflare.WorkerEnv {}
function fromInterface<E extends IEnv>(given: E): D1Database {
	return router.getHandle(mapping, given).handle
}
function fromWrangler<E extends WranglerEnv>(given: E): D1Database {
	return router.getHandle(mapping, given).handle
}
expectTypeOf(fromInterface(ienv)).toEqualTypeOf<D1Database>()
expectTypeOf(fromWrangler(staging)).toEqualTypeOf<D1Database>()
declare const plain: { DB: string; SHARD_DB_0: D1Database }
expectTypeOf(router.getHandle(mapping, plain).handle).toEqualTypeOf<D1Database>()
declare const optional: { SHARD_DB_0: D1Database; SHARD_DB_1?: D1Database }
expectTypeOf(router.getHandle(mapping, optional).handle).toEqualTypeOf<D1Database>()
/* 0.20's type argument is refused, on an interface env and a type-alias one alike */
// @ts-expect-error getHandle takes no binding type argument
router.getHandle<D1Database>(mapping, ienv)
// @ts-expect-error getHandle takes no binding type argument
router.getHandle<D1Database>(mapping, tenv)
// @ts-expect-error an empty env holds no shard
router.getHandle(mapping, {})
interface Empty {}
declare const empty: Empty
// @ts-expect-error an empty interface env holds no shard
router.getHandle(mapping, empty)
declare const anyObject: object
// @ts-expect-error an object env holds no shard
router.getHandle(mapping, anyObject)
declare const mixed: { SHARD_DB_0: D1Database; SHARD_DB_1: KVNamespace }
// @ts-expect-error every shard key holds a D1 binding
router.getHandle(mapping, mixed)
declare const map: Map<string, D1Database>
// @ts-expect-error a Map holds its bindings as entries, not keys
router.getHandle(mapping, map)
function fromObject<E extends object>(given: E) {
	// @ts-expect-error a bound of object holds no shard
	return router.getHandle(mapping, given)
}
function fromNoShard<E extends { DB: D1Database }>(given: E) {
	// @ts-expect-error a bound with no shard key holds no shard
	return router.getHandle(mapping, given)
}
function fromStringShard<E extends { SHARD_DB_0: string }>(given: E) {
	// @ts-expect-error a bound whose shard key holds a string holds no D1 binding
	return router.getHandle(mapping, given)
}
function fromKvShard<E extends { DB: D1Database; SHARD_DB_0: KVNamespace }>(given: E) {
	// @ts-expect-error a bound whose shard key holds a KV holds no D1 binding
	return router.getHandle(mapping, given)
}
expectTypeOf([fromObject, fromNoShard, fromStringShard, fromKvShard]).toBeArray()

/* K4 of r22: a consumer's helper names comb's D1 bound from the subpath it calls, and returns the binding's own session type */
function sessionOf<D extends SessionBound>(binding: D): SessionOf<D> | undefined {
	return openD1Session(binding).session
}
expectTypeOf(sessionOf(db)).toEqualTypeOf<D1DatabaseSession | undefined>()
expectTypeOf<ShardBound>().toEqualTypeOf<SessionBound>()
