/**
 * Unified column factories for PostgreSQL
 *
 * Provides dialect-agnostic column definitions that can be swapped with SQLite
 */
import { sql } from "drizzle-orm"
import { boolean, doublePrecision, integer, jsonb, serial, text } from "drizzle-orm/pg-core"

const timestampDefaults = {
	now: () => sql`(extract(epoch from now()) * 1000)::integer`,
}

export const c = {
	/* Native boolean */
	boolean: (name: string) => boolean(name),

	/* Standard createdAt timestamp */
	createdAt: (name: "createdAt" | "created_at") => integer(name).notNull().default(timestampDefaults.now()),

	/* Standard deletedAt timestamp (nullable) */
	deletedAt: (name: "deletedAt" | "deleted_at") => integer(name),

	/* Enum stored as text with type annotation */
	enum: <T extends readonly string[]>(name: string, _values: T) => text(name).$type<T[number]>(),

	/* Text primary key — prefix is type-erased metadata for codegen */
	id: (_prefix: string) => text("id").primaryKey(),

	/* Integer */
	integer: (name: string) => integer(name),

	/* Native JSONB */
	json: <T>(name: string) => jsonb(name).$type<T>(),

	/* Floating point (double precision) */
	real: (name: string) => doublePrecision(name),

	/* Foreign key reference - use with .references() */
	ref: (name: string) => text(name),

	/* Auto-increment integer primary key */
	serialId: () => serial("id").primaryKey(),

	/* Text (PostgreSQL text has no length limit, length param ignored for compatibility) */
	text: (name: string, _length?: number) => text(name),

	/* Timestamp as integer (milliseconds) */
	timestamp: (name: string) => integer(name),

	/* Standard updatedAt timestamp with $onUpdate */
	updatedAt: (name: "updatedAt" | "updated_at") =>
		integer(name)
			.notNull()
			.default(timestampDefaults.now())
			.$onUpdate(() => Date.now()),
}
