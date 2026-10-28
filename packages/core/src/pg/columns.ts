/**
 * Unified column factories for PostgreSQL
 *
 * Provides dialect-agnostic column definitions that can be swapped with SQLite
 */
import { sql } from "drizzle-orm"
import {
	bigint,
	boolean,
	doublePrecision,
	integer,
	jsonb,
	type PgBigInt53Builder,
	type PgBooleanBuilder,
	type PgDoublePrecisionBuilder,
	type PgIntegerBuilder,
	type PgJsonbBuilder,
	type PgSerialBuilder,
	type PgTextBuilder,
	serial,
	type Set$Type,
	type SetHasDefault,
	type SetIsPrimaryKey,
	type SetNotNull,
	text,
} from "drizzle-orm/pg-core"
import { withCombColumn } from "../meta/column.ts"
/* Constraint types are dialect-agnostic; they live under sqlite/ because that is
   the published export path and moving them would be a breaking change. */
import type {
	EnumStates,
	IntegerConstraints,
	JsonConstraints,
	TextConstraints,
	TimestampConstraints,
} from "../sqlite/constraints.ts"
import type * as z from "zod"
import { checkPrefix } from "../id.ts"

/* Epoch milliseconds (about 1.76e12) overflow a 4-byte integer; bigint in number mode holds them
   exactly up to 2^53, and reads back as a JS number like the SQLite columns do. */
const epochMs = (name: string) => bigint(name, { mode: "number" })

const timestampDefaults = {
	now: () => sql`(extract(epoch from now()) * 1000)::bigint`,
}

type Text = PgTextBuilder<[string, ...string[]]>

type CreatedAtName = "createdAt" | "created_at"
type DeletedAtName = "deletedAt" | "deleted_at"
type UpdatedAtName = "updatedAt" | "updated_at"

/**
 * What each `c` factory returns: drizzle's own builder types, spelled out for isolated
 * declarations. The parameters are SQLite's, so one tables file compiles under either dialect;
 * the constraints are read by codegen and erased at runtime.
 */
type PgColumns = {
	boolean: (name: string) => PgBooleanBuilder
	createdAt: (name: CreatedAtName, _constraints?: TimestampConstraints) => SetHasDefault<SetNotNull<PgBigInt53Builder>>
	deletedAt: (name: DeletedAtName, _constraints?: TimestampConstraints) => PgBigInt53Builder
	enum: <T extends readonly string[]>(
		name: string,
		_values: T,
		_states?: EnumStates<T[number]>,
	) => Set$Type<Text, T[number]>
	id: (_prefix: string) => SetIsPrimaryKey<Text>
	integer: (name: string, _constraints?: IntegerConstraints) => PgIntegerBuilder
	json: <TSchema extends z.ZodTypeAny = z.ZodTypeAny>(
		name: string,
		_schema: TSchema,
		_constraints?: JsonConstraints,
	) => Set$Type<PgJsonbBuilder, z.infer<TSchema>>
	real: (name: string, _constraints?: IntegerConstraints) => PgDoublePrecisionBuilder
	ref: (name: string, _constraints?: TextConstraints) => Text
	serialId: () => SetIsPrimaryKey<PgSerialBuilder>
	text: (name: string, _constraints?: TextConstraints) => Text
	timestamp: (name: string, _constraints?: TimestampConstraints) => PgBigInt53Builder
	updatedAt: (
		name: UpdatedAtName,
		_constraints?: TimestampConstraints,
	) => SetHasDefault<SetHasDefault<SetNotNull<PgBigInt53Builder>>>
}

export const c: PgColumns = {
	/* Native boolean */
	boolean: (name: string) => withCombColumn(boolean(name), { kind: "boolean" }),

	/* Standard createdAt timestamp */
	createdAt: (name: CreatedAtName, constraints?: TimestampConstraints) =>
		withCombColumn(epochMs(name).notNull().default(timestampDefaults.now()), { constraints, kind: "createdAt" }),

	/* Standard deletedAt timestamp (nullable) */
	deletedAt: (name: DeletedAtName, constraints?: TimestampConstraints) =>
		withCombColumn(epochMs(name), { constraints, kind: "deletedAt" }),

	/* Enum stored as text with type annotation */
	enum: <T extends readonly string[]>(name: string, values: T, states?: EnumStates<T[number]>) =>
		withCombColumn(text(name).$type<T[number]>(), { kind: "enum", states, values }),

	/* Text primary key — prefix is type-erased metadata for codegen */
	id: (prefix: string) => {
		checkPrefix(prefix)
		return withCombColumn(text("id").primaryKey(), { kind: "id", prefix })
	},

	/* Integer */
	integer: (name: string, constraints?: IntegerConstraints) =>
		withCombColumn(integer(name), { constraints, kind: "integer" }),

	/* Native JSONB, typed by its Zod schema */
	json: <TSchema extends z.ZodTypeAny = z.ZodTypeAny>(name: string, schema: TSchema, constraints?: JsonConstraints) =>
		withCombColumn(jsonb(name).$type<z.infer<TSchema>>(), { constraints, kind: "json", schema }),

	/* Floating point (double precision) */
	real: (name: string, constraints?: IntegerConstraints) =>
		withCombColumn(doublePrecision(name), { constraints, kind: "real" }),

	/* Foreign key reference - use with .references() */
	ref: (name: string, constraints?: TextConstraints) => withCombColumn(text(name), { constraints, kind: "ref" }),

	/* Auto-increment integer primary key */
	serialId: () => withCombColumn(serial("id").primaryKey(), { kind: "serialId" }),

	/* Text: PostgreSQL text has no length limit, so `max` bounds the generated DTOs only */
	text: (name: string, constraints?: TextConstraints) => withCombColumn(text(name), { constraints, kind: "text" }),

	/* Timestamp as integer (milliseconds) */
	timestamp: (name: string, constraints?: TimestampConstraints) =>
		withCombColumn(epochMs(name), { constraints, kind: "timestamp" }),

	/* Standard updatedAt timestamp with $onUpdate */
	updatedAt: (name: UpdatedAtName, constraints?: TimestampConstraints) =>
		withCombColumn(
			epochMs(name)
				.notNull()
				.default(timestampDefaults.now())
				.$onUpdate(() => Date.now()),
			{ constraints, kind: "updatedAt" },
		),
}
