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
import { withCombColumn } from "../meta/column.ts"
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
	enum: <T extends readonly string[]>(name: string, values: T, states?: EnumStates<T[number]>) =>
		withCombColumn(text(name).$type<T[number]>(), { kind: "enum", states, values }),

	/* Text primary key — prefix is type-erased metadata for codegen */
	id: (prefix: string) => withCombColumn(text("id").primaryKey(), { kind: "id", prefix }),

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
