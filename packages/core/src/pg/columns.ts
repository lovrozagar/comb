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
import { enumMeta, withCombColumn } from "../meta/column.ts"
/* Constraint types are dialect-agnostic; they live under sqlite/ because that is
   the published export path and moving them would be a breaking change. */
import type {
	EnumOptions,
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

/** A Postgres text column builder */
type Text = PgTextBuilder<[string, ...string[]]>

/** The names a creation timestamp may take, in either casing, so codegen recognizes it */
type CreatedAtName = "createdAt" | "created_at"
/** The names a soft-delete timestamp may take, in either casing, so codegen recognizes it */
type DeletedAtName = "deletedAt" | "deleted_at"
/** The names an update timestamp may take, in either casing, so codegen recognizes it */
type UpdatedAtName = "updatedAt" | "updated_at"

/**
 * What each `c` factory returns: drizzle's own builder types, spelled out for isolated
 * declarations. The parameters are SQLite's, so one tables file compiles under either dialect;
 * the constraints are read by codegen and erased at runtime.
 */
export type PgColumns = {
	/** a native boolean, where SQLite stores an INTEGER 0 or 1 */
	boolean: (name: string) => PgBooleanBuilder
	/**
	 * the creation time in epoch milliseconds, a NOT NULL bigint read as a JavaScript number, filled by
	 * the database when a row is inserted: its transaction's start time (`now()`) to the millisecond,
	 * where SQLite's fill keeps whole seconds
	 */
	createdAt: (name: CreatedAtName, _constraints?: TimestampConstraints) => SetHasDefault<SetNotNull<PgBigInt53Builder>>
	/** the soft-delete time in epoch milliseconds, a bigint read as a JavaScript number; null while the row is live */
	deletedAt: (name: DeletedAtName, _constraints?: TimestampConstraints) => PgBigInt53Builder
	/**
	 * one of `values`, stored as text, not as a Postgres enum type; the enum-checks generator writes a
	 * CHECK holding it to them, in force once the table's extra config returns `<table>EnumChecks(table)`
	 */
	enum: <T extends readonly string[]>(
		name: string,
		_values: T,
		_options?: EnumOptions<T[number]>,
	) => Set$Type<Text, T[number]>
	/**
	 * The text primary key `id`, holding `<prefix>_<ulid>` ids the app writes with `generateId(prefix)`.
	 * Throws unless `prefix` is 2 to 10 lowercase letters and digits starting with a letter
	 */
	id: (_prefix: string) => SetIsPrimaryKey<Text>
	/**
	 * a 4-byte integer, -2147483648 to 2147483647, where SQLite's holds a JavaScript number's exact
	 * range; the generated DTOs clamp a declared `min` and `max` to it
	 */
	integer: (name: string, _constraints?: IntegerConstraints) => PgIntegerBuilder
	/**
	 * a JSON value stored as jsonb, which keeps neither key order nor a duplicate key, typed by `schema`,
	 * which the generated DTOs validate it with
	 */
	json: <TSchema extends z.ZodTypeAny = z.ZodTypeAny>(
		name: string,
		_schema: TSchema,
		_constraints?: JsonConstraints,
	) => Set$Type<PgJsonbBuilder, z.infer<TSchema>>
	/** a floating-point number, stored as double precision */
	real: (name: string, _constraints?: IntegerConstraints) => PgDoublePrecisionBuilder
	/** a text foreign key; chain `.references()` to name the column it points at */
	ref: (name: string, _constraints?: TextConstraints) => Text
	/** the auto-incrementing 4-byte `serial` primary key `id`, filled by the database */
	serialId: () => SetIsPrimaryKey<PgSerialBuilder>
	/**
	 * a text column with no declared length: a declared `max` bounds the generated DTOs alone, where
	 * SQLite also declares it as the column's length
	 */
	text: (name: string, _constraints?: TextConstraints) => Text
	/** a point in time in epoch milliseconds, stored as a bigint and read as a JavaScript number */
	timestamp: (name: string, _constraints?: TimestampConstraints) => PgBigInt53Builder
	/**
	 * the update time in epoch milliseconds, a NOT NULL bigint, filled on insert as `createdAt` is and
	 * set to the current time on every update drizzle writes
	 */
	updatedAt: (
		name: UpdatedAtName,
		_constraints?: TimestampConstraints,
	) => SetHasDefault<SetHasDefault<SetNotNull<PgBigInt53Builder>>>
}

/**
 * comb's Postgres column helpers: drizzle columns that also record comb's constraints, which codegen
 * reads to write the DTOs, constraint map and manifest. The same helpers exist for SQLite in
 * `./sqlite/columns`, so a tables file moves between the dialects by its import
 */
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
	enum: <T extends readonly string[]>(name: string, values: T, options?: EnumOptions<T[number]>) =>
		withCombColumn(text(name).$type<T[number]>(), enumMeta(values, options)),

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
