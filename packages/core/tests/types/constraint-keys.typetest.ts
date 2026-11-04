/**
 * CD9 of r22b: the keys codegen lets each c helper take are the keys of the constraint type that
 * helper's own signature takes, on both dialects, so neither the sets nor the types drift: a key
 * added to a type and not to its set would be refused at codegen, and one in a set its type lacks
 * would be taken from a JavaScript caller alone. Checked by `bun run typecheck`; nothing here runs.
 */
import { expectTypeOf } from "vitest"
import type { ConstraintKeys } from "../../src/codegen/annotations.ts"
import type { PgColumns } from "../../src/pg/columns.ts"
import type { EnumStates } from "../../src/sqlite/constraints.ts"
import type { SqliteColumns } from "../../src/sqlite/columns.ts"

type Columns = PgColumns | SqliteColumns

/** The record a helper is given: its last parameter, after a c.json's schema or a c.enum's values; none for c.serialId */
type Given<K extends keyof SqliteColumns> = K extends "enum" | "json"
	? Parameters<Columns[K]>[2]
	: Parameters<Columns[K]> extends [unknown, (infer C)?]
		? C
		: Record<never, never>

/** The keys that record names: c.enum's flags beside its state machine */
type Taken<K extends keyof SqliteColumns> = K extends "enum"
	? Exclude<keyof NonNullable<Given<K>>, keyof EnumStates>
	: keyof NonNullable<Given<K>>

type Set<K extends keyof ConstraintKeys> = ConstraintKeys[K][number]

expectTypeOf<Set<"boolean">>().toEqualTypeOf<Taken<"boolean">>()
expectTypeOf<Set<"createdAt">>().toEqualTypeOf<Taken<"createdAt">>()
expectTypeOf<Set<"deletedAt">>().toEqualTypeOf<Taken<"deletedAt">>()
expectTypeOf<Set<"enum">>().toEqualTypeOf<Taken<"enum">>()
expectTypeOf<Set<"id">>().toEqualTypeOf<Taken<"id">>()
expectTypeOf<Set<"integer">>().toEqualTypeOf<Taken<"integer">>()
expectTypeOf<Set<"json">>().toEqualTypeOf<Taken<"json">>()
expectTypeOf<Set<"real">>().toEqualTypeOf<Taken<"real">>()
expectTypeOf<Set<"ref">>().toEqualTypeOf<Taken<"ref">>()
expectTypeOf<Set<"serialId">>().toEqualTypeOf<Taken<"serialId">>()
expectTypeOf<Set<"text">>().toEqualTypeOf<Taken<"text">>()
expectTypeOf<Set<"timestamp">>().toEqualTypeOf<Taken<"timestamp">>()
expectTypeOf<Set<"updatedAt">>().toEqualTypeOf<Taken<"updatedAt">>()
/* every helper is held: a helper added to c without a set fails here */
expectTypeOf<keyof ConstraintKeys>().toEqualTypeOf<keyof SqliteColumns>()
expectTypeOf<keyof PgColumns>().toEqualTypeOf<keyof SqliteColumns>()
