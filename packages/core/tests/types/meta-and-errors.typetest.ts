/**
 * The meta readers' results and the error handlers' signatures, as a consumer's compiler sees
 * them. Checked by `bun run typecheck`; nothing here runs.
 */
import { expectTypeOf } from "vitest"
import {
	type CombEntityMeta,
	type CombMeta,
	type CombQueryMeta,
	readCombEntityMeta,
	readCombMeta,
	readCombQueryMeta,
} from "../../src/meta.ts"
import { pgErrorHandler } from "../../src/pg/error-handler.ts"
import { sqliteErrorHandler } from "../../src/sqlite/constraint-handler.ts"
import { d1ErrorHandler } from "../../src/sqlite/d1/error-handler.ts"
import type { DatabaseErrorHandler } from "../../src/types.ts"

expectTypeOf(readCombMeta).returns.toEqualTypeOf<CombMeta | null>()
expectTypeOf(readCombEntityMeta).returns.toEqualTypeOf<CombEntityMeta | null>()
expectTypeOf(readCombQueryMeta).returns.toEqualTypeOf<CombQueryMeta | null>()
/* a reader takes anything: it is the one that decides what the input holds */
expectTypeOf(readCombMeta).parameter(0).toEqualTypeOf<unknown>()

/* every handler fits the one shape an app wires in, and returns nothing: it throws or falls through */
expectTypeOf(sqliteErrorHandler).toMatchTypeOf<DatabaseErrorHandler>()
expectTypeOf(d1ErrorHandler).toMatchTypeOf<DatabaseErrorHandler>()
expectTypeOf(pgErrorHandler).toMatchTypeOf<DatabaseErrorHandler>()
expectTypeOf(d1ErrorHandler).returns.toEqualTypeOf<void>()
