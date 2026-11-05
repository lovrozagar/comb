/**
 * Unified column factories for SQLite
 *
 * Provides dialect-agnostic column definitions that can be swapped with PostgreSQL
 */

import { type $Type, type HasDefault, type IsPrimaryKey, type NotNull, sql } from "drizzle-orm"
import {
	integer,
	real,
	type SQLiteBooleanBuilder,
	type SQLiteIntegerBuilder,
	type SQLiteRealBuilder,
	type SQLiteTextBuilder,
	type SQLiteTextJsonBuilder,
	text,
} from "drizzle-orm/sqlite-core"
import type * as z from "zod"
import { enumMeta, withCombColumn } from "../meta/column.ts"
import type {
	EnumOptions,
	IntegerConstraints,
	JsonConstraints,
	TextConstraints,
	TimestampConstraints,
} from "./constraints.ts"
import { checkPrefix } from "../id.ts"

const timestampDefaults = {
	now: () => sql`(unixepoch() * 1000)`,
}

/** A SQLite TEXT column builder */
type Text = SQLiteTextBuilder<[string, ...string[]]>
/** The names a creation timestamp may take, in either casing, so codegen recognizes it */
type CreatedAtName = "createdAt" | "created_at"
/** The names a soft-delete timestamp may take, in either casing, so codegen recognizes it */
type DeletedAtName = "deletedAt" | "deleted_at"
/** The names an update timestamp may take, in either casing, so codegen recognizes it */
type UpdatedAtName = "updatedAt" | "updated_at"

/** What each `c` factory returns: drizzle's own builder types, spelled out for isolated declarations */
export type SqliteColumns = {
	/** a boolean, stored as an INTEGER 0 or 1 */
	boolean: (name: string) => SQLiteBooleanBuilder
	/** the creation time in epoch milliseconds, NOT NULL, filled by the database when a row is inserted */
	createdAt: (name: CreatedAtName, _constraints?: TimestampConstraints) => HasDefault<NotNull<SQLiteIntegerBuilder>>
	/** the soft-delete time in epoch milliseconds; null while the row is live */
	deletedAt: (name: DeletedAtName, _constraints?: TimestampConstraints) => SQLiteIntegerBuilder
	/** one of `values`, stored as TEXT; the enum-checks generator writes a CHECK holding it to them, in force once the table's extra config returns `<table>EnumChecks(table)` */
	enum: <T extends readonly string[]>(
		name: string,
		_values: T,
		_options?: EnumOptions<T[number]>,
	) => $Type<Text, T[number]>
	/**
	 * The TEXT primary key `id`, holding `<prefix>_<ulid>` ids the app writes with `generateId(prefix)`.
	 * Throws unless `prefix` is 2 to 10 lowercase letters and digits starting with a letter
	 */
	id: (_prefix: string) => IsPrimaryKey<Text>
	/** an INTEGER read as a JavaScript number */
	integer: (name: string, _constraints?: IntegerConstraints) => SQLiteIntegerBuilder
	/** a JSON value stored as TEXT, typed and validated by `schema` in the generated DTOs */
	json: <TSchema extends z.ZodTypeAny = z.ZodTypeAny>(
		name: string,
		_schema: TSchema,
		_constraints?: JsonConstraints,
	) => $Type<SQLiteTextJsonBuilder, z.infer<TSchema>>
	/** a floating-point REAL */
	real: (name: string, _constraints?: IntegerConstraints) => SQLiteRealBuilder
	/** a TEXT foreign key; chain `.references()` to name the column it points at */
	ref: (name: string, _constraints?: TextConstraints) => Text
	/** the auto-incrementing INTEGER primary key `id`, filled by the database */
	serialId: () => IsPrimaryKey<HasDefault<NotNull<SQLiteIntegerBuilder>>>
	/** a TEXT column; a declared `max` also becomes its declared length */
	text: (name: string, _constraints?: TextConstraints) => Text
	/** a point in time in epoch milliseconds, stored as an INTEGER */
	timestamp: (name: string, _constraints?: TimestampConstraints) => SQLiteIntegerBuilder
	/** the update time in epoch milliseconds, NOT NULL, filled on insert and set to the current time on every update drizzle writes */
	updatedAt: (
		name: UpdatedAtName,
		_constraints?: TimestampConstraints,
	) => HasDefault<HasDefault<NotNull<SQLiteIntegerBuilder>>>
}

/**
 * comb's SQLite column helpers: drizzle columns that also record comb's constraints, which codegen
 * reads to write the DTOs, constraint map and manifest. The same helpers exist for Postgres in
 * `./pg/columns`, so a tables file moves between the dialects by its import
 */
export const c: SqliteColumns = {
	/* Boolean as integer */
	boolean: (name: string) => withCombColumn(integer(name, { mode: "boolean" }), { kind: "boolean" }),

	/* Standard createdAt timestamp */
	createdAt: (name: "createdAt" | "created_at", constraints?: TimestampConstraints) =>
		withCombColumn(integer(name, { mode: "number" }).notNull().default(timestampDefaults.now()), {
			constraints,
			kind: "createdAt",
		}),

	/* Standard deletedAt timestamp (nullable) */
	deletedAt: (name: "deletedAt" | "deleted_at", constraints?: TimestampConstraints) =>
		withCombColumn(integer(name, { mode: "number" }), { constraints, kind: "deletedAt" }),

	/* Enum stored as text with type annotation */
	enum: <T extends readonly string[]>(name: string, values: T, options?: EnumOptions<T[number]>) =>
		withCombColumn(text(name).$type<T[number]>(), enumMeta(values, options)),

	/* Text primary key — prefix is type-erased metadata for codegen */
	id: (prefix: string) => {
		checkPrefix(prefix)
		return withCombColumn(text("id").primaryKey(), { kind: "id", prefix })
	},

	/* Integer with number mode */
	integer: (name: string, constraints?: IntegerConstraints) =>
		withCombColumn(integer(name, { mode: "number" }), { constraints, kind: "integer" }),

	/* JSON stored as text with Zod schema */
	json: <TSchema extends z.ZodTypeAny = z.ZodTypeAny>(name: string, schema: TSchema, constraints?: JsonConstraints) =>
		withCombColumn(text(name, { mode: "json" }).$type<z.infer<TSchema>>(), { constraints, kind: "json", schema }),

	/* Floating point */
	real: (name: string, constraints?: IntegerConstraints) => withCombColumn(real(name), { constraints, kind: "real" }),

	/* Foreign key reference - use with .references() */
	ref: (name: string, constraints?: TextConstraints) => withCombColumn(text(name), { constraints, kind: "ref" }),

	/* Auto-increment integer primary key */
	serialId: () =>
		withCombColumn(integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }), { kind: "serialId" }),

	/* Text with optional constraints */
	text: (name: string, constraints?: TextConstraints) =>
		withCombColumn(constraints?.max ? text(name, { length: constraints.max }) : text(name), {
			constraints,
			kind: "text",
		}),

	/* Timestamp as integer (milliseconds) */
	timestamp: (name: string, constraints?: TimestampConstraints) =>
		withCombColumn(integer(name, { mode: "number" }), { constraints, kind: "timestamp" }),

	/* Standard updatedAt timestamp with $onUpdate */
	updatedAt: (name: "updatedAt" | "updated_at", constraints?: TimestampConstraints) =>
		withCombColumn(
			integer(name, { mode: "number" })
				.notNull()
				.default(timestampDefaults.now())
				.$onUpdate(() => Date.now()),
			{ constraints, kind: "updatedAt" },
		),
}
