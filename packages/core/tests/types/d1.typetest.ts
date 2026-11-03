/**
 * K3 of r21: comb's D1 modules type a binding by the methods they call, so `wrangler types`'
 * globals and `@cloudflare/workers-types` both fit, and a session comes back in the binding's own
 * type, which drizzle() takes. Checked by `bun run typecheck`; nothing here runs.
 */
import type { D1Database, D1DatabaseSession, D1PreparedStatement } from "@cloudflare/workers-types"
import { expectTypeOf } from "vitest"
import { BookmarkTracker } from "../../src/sqlite/d1/bookmark.ts"
import type { D1DatabaseLike, D1SessionLike } from "../../src/sqlite/d1/d1-types.ts"
import { openD1Session } from "../../src/sqlite/d1/session.ts"
import { ShardRouter } from "../../src/sqlite/d1/sharding/router.ts"
import type { ShardKv } from "../../src/sqlite/d1/sharding/types.ts"

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

/* the router takes the caller's binding and statements, and hands a shard's binding back as the caller names it */
const router = new ShardRouter({ totalShards: 1 })
void router.move({ orgId: "o", shardId: 0, with: [statement] }, { coreDb: db, kv }, { waitUntil: () => {} })
expectTypeOf(router.getHandle<D1Database>({} as never, {}).handle).toEqualTypeOf<D1Database>()
expectTypeOf(router.getHandle({} as never, {}).handle).toEqualTypeOf<D1DatabaseLike>()
