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
import type {
	EnumStates,
	IntegerConstraints,
	JsonConstraints,
	TextConstraints,
	TimestampConstraints,
} from "./constraints.ts"

const timestampDefaults = {
	now: () => sql`(unixepoch() * 1000)`,
}

type Text = SQLiteTextBuilder<[string, ...string[]]>
type CreatedAtName = "createdAt" | "created_at"
type DeletedAtName = "deletedAt" | "deleted_at"
type UpdatedAtName = "updatedAt" | "updated_at"

/** What each `c` factory returns: drizzle's own builder types, spelled out for isolated declarations */
export type SqliteColumns = {
	boolean: (name: string) => SQLiteBooleanBuilder
	createdAt: (name: CreatedAtName, _constraints?: TimestampConstraints) => HasDefault<NotNull<SQLiteIntegerBuilder>>
	deletedAt: (name: DeletedAtName, _constraints?: TimestampConstraints) => SQLiteIntegerBuilder
	enum: <T extends readonly string[]>(
		name: string,
		_values: T,
		_states?: EnumStates<T[number]>,
	) => $Type<Text, T[number]>
	id: (_prefix: string) => IsPrimaryKey<Text>
	integer: (name: string, _constraints?: IntegerConstraints) => SQLiteIntegerBuilder
	json: <TSchema extends z.ZodTypeAny = z.ZodTypeAny>(
		name: string,
		_schema: TSchema,
		_constraints?: JsonConstraints,
	) => $Type<SQLiteTextJsonBuilder, z.infer<TSchema>>
	real: (name: string, _constraints?: IntegerConstraints) => SQLiteRealBuilder
	ref: (name: string, _constraints?: TextConstraints) => Text
	serialId: () => IsPrimaryKey<HasDefault<NotNull<SQLiteIntegerBuilder>>>
	text: (name: string, _constraints?: TextConstraints) => Text
	timestamp: (name: string, _constraints?: TimestampConstraints) => SQLiteIntegerBuilder
	updatedAt: (
		name: UpdatedAtName,
		_constraints?: TimestampConstraints,
	) => HasDefault<HasDefault<NotNull<SQLiteIntegerBuilder>>>
}

export const c: SqliteColumns = {
	/* Boolean as integer */
	boolean: (name: string) => integer(name, { mode: "boolean" }),

	/* Standard createdAt timestamp */
	createdAt: (name: "createdAt" | "created_at", _constraints?: TimestampConstraints) =>
		integer(name, { mode: "number" }).notNull().default(timestampDefaults.now()),

	/* Standard deletedAt timestamp (nullable) */
	deletedAt: (name: "deletedAt" | "deleted_at", _constraints?: TimestampConstraints) =>
		integer(name, { mode: "number" }),

	/* Enum stored as text with type annotation */
	enum: <T extends readonly string[]>(name: string, _values: T, _states?: EnumStates<T[number]>) =>
		text(name).$type<T[number]>(),

	/* Text primary key — prefix is type-erased metadata for codegen */
	id: (_prefix: string) => text("id").primaryKey(),

	/* Integer with number mode */
	integer: (name: string, _constraints?: IntegerConstraints) => integer(name, { mode: "number" }),

	/* JSON stored as text with Zod schema */
	json: <TSchema extends z.ZodTypeAny = z.ZodTypeAny>(name: string, _schema: TSchema, _constraints?: JsonConstraints) =>
		text(name, { mode: "json" }).$type<z.infer<TSchema>>(),

	/* Floating point */
	real: (name: string, _constraints?: IntegerConstraints) => real(name),

	/* Foreign key reference - use with .references() */
	ref: (name: string, _constraints?: TextConstraints) => text(name),

	/* Auto-increment integer primary key */
	serialId: () => integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),

	/* Text with optional constraints */
	text: (name: string, _constraints?: TextConstraints) =>
		_constraints?.max ? text(name, { length: _constraints.max }) : text(name),

	/* Timestamp as integer (milliseconds) */
	timestamp: (name: string, _constraints?: TimestampConstraints) => integer(name, { mode: "number" }),

	/* Standard updatedAt timestamp with $onUpdate */
	updatedAt: (name: "updatedAt" | "updated_at", _constraints?: TimestampConstraints) =>
		integer(name, { mode: "number" })
			.notNull()
			.default(timestampDefaults.now())
			.$onUpdate(() => Date.now()),
}
