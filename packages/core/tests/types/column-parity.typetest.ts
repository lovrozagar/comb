/**
 * `c`'s factories carry hand-written return types (isolatedDeclarations needs them). Each table
 * here is built twice, with `c` and with the raw drizzle builders `c` wraps, and the select and
 * insert rows must be equal: an annotation that drifts from what drizzle infers fails to compile.
 * Checked by `bun run typecheck`; nothing here runs.
 */
import { sql } from "drizzle-orm"
import {
	bigint,
	boolean,
	doublePrecision,
	integer as pgInteger,
	jsonb,
	pgTable,
	serial,
	text as pgText,
} from "drizzle-orm/pg-core"
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { expectTypeOf } from "vitest"
import * as z from "zod"
import { c as pg } from "../../src/pg/columns.ts"
import { c } from "../../src/sqlite/columns.ts"

const settings = z.object({ theme: z.enum(["light", "dark"]) })
const payload = z.object({ n: z.number() })
const STATUS = ["draft", "sent"] as const
const now = sql`0`

const viaComb = sqliteTable("t", {
	active: c.boolean("active"),
	created_at: c.createdAt("created_at"),
	deleted_at: c.deletedAt("deleted_at"),
	id: c.id("tst"),
	n: c.integer("n"),
	owner_id: c.ref("owner_id"),
	score: c.real("score"),
	seen_at: c.timestamp("seen_at"),
	settings: c.json("settings", settings),
	status: c.enum("status", STATUS),
	title: c.text("title", { max: 10 }),
	updated_at: c.updatedAt("updated_at"),
})
const viaDrizzle = sqliteTable("t", {
	active: integer("active", { mode: "boolean" }),
	created_at: integer("created_at", { mode: "number" }).notNull().default(now),
	deleted_at: integer("deleted_at", { mode: "number" }),
	id: text("id").primaryKey(),
	n: integer("n", { mode: "number" }),
	owner_id: text("owner_id"),
	score: real("score"),
	seen_at: integer("seen_at", { mode: "number" }),
	settings: text("settings", { mode: "json" }).$type<z.infer<typeof settings>>(),
	status: text("status").$type<(typeof STATUS)[number]>(),
	title: text("title", { length: 10 }),
	updated_at: integer("updated_at", { mode: "number" })
		.notNull()
		.default(now)
		.$onUpdate(() => 0),
})
expectTypeOf<typeof viaComb.$inferSelect>().toEqualTypeOf<typeof viaDrizzle.$inferSelect>()
expectTypeOf<typeof viaComb.$inferInsert>().toEqualTypeOf<typeof viaDrizzle.$inferInsert>()

const serialViaComb = sqliteTable("s", { id: c.serialId() })
const serialViaDrizzle = sqliteTable("s", { id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }) })
expectTypeOf<typeof serialViaComb.$inferSelect>().toEqualTypeOf<typeof serialViaDrizzle.$inferSelect>()
expectTypeOf<typeof serialViaComb.$inferInsert>().toEqualTypeOf<typeof serialViaDrizzle.$inferInsert>()

const pgViaComb = pgTable("t", {
	active: pg.boolean("active"),
	created_at: pg.createdAt("created_at"),
	deleted_at: pg.deletedAt("deleted_at"),
	id: pg.id("tst"),
	n: pg.integer("n"),
	owner_id: pg.ref("owner_id"),
	payload: pg.json("payload", payload),
	score: pg.real("score"),
	seen_at: pg.timestamp("seen_at"),
	status: pg.enum("status", STATUS),
	title: pg.text("title"),
	updated_at: pg.updatedAt("updated_at"),
})
const pgViaDrizzle = pgTable("t", {
	active: boolean("active"),
	created_at: bigint("created_at", { mode: "number" }).notNull().default(now),
	deleted_at: bigint("deleted_at", { mode: "number" }),
	id: pgText("id").primaryKey(),
	n: pgInteger("n"),
	owner_id: pgText("owner_id"),
	payload: jsonb("payload").$type<{ n: number }>(),
	score: doublePrecision("score"),
	seen_at: bigint("seen_at", { mode: "number" }),
	status: pgText("status").$type<(typeof STATUS)[number]>(),
	title: pgText("title"),
	updated_at: bigint("updated_at", { mode: "number" })
		.notNull()
		.default(now)
		.$onUpdate(() => 0),
})
expectTypeOf<typeof pgViaComb.$inferSelect>().toEqualTypeOf<typeof pgViaDrizzle.$inferSelect>()
expectTypeOf<typeof pgViaComb.$inferInsert>().toEqualTypeOf<typeof pgViaDrizzle.$inferInsert>()

const pgSerialViaComb = pgTable("s", { id: pg.serialId() })
const pgSerialViaDrizzle = pgTable("s", { id: serial("id").primaryKey() })
expectTypeOf<typeof pgSerialViaComb.$inferSelect>().toEqualTypeOf<typeof pgSerialViaDrizzle.$inferSelect>()
expectTypeOf<typeof pgSerialViaComb.$inferInsert>().toEqualTypeOf<typeof pgSerialViaDrizzle.$inferInsert>()

/* One tables file compiles under either dialect by swapping the import (D8, E-S4): every factory
   takes the same arguments, constraints included. */
type ParamsOf<T, K extends keyof T> = T[K] extends (...args: infer P) => unknown ? P : never
type Factories = keyof typeof c
expectTypeOf<{ [K in Factories]: ParamsOf<typeof pg, K> }>().toEqualTypeOf<{
	[K in Factories]: ParamsOf<typeof c, K>
}>()

const sqliteAccount = sqliteTable("account", {
	balance: c.integer("balance", { min: 0 }),
	email: c.text("email", { email: true, max: 254 }),
	id: c.id("acc"),
	password_hash: c.text("password_hash", { private: true }),
	settings: c.json("settings", settings, { maxBytes: 1024 }),
})
const pgAccount = pgTable("account", {
	balance: pg.integer("balance", { min: 0 }),
	email: pg.text("email", { email: true, max: 254 }),
	id: pg.id("acc"),
	password_hash: pg.text("password_hash", { private: true }),
	settings: pg.json("settings", settings, { maxBytes: 1024 }),
})
expectTypeOf<typeof pgAccount.$inferSelect>().toEqualTypeOf<typeof sqliteAccount.$inferSelect>()
expectTypeOf<typeof pgAccount.$inferInsert>().toEqualTypeOf<typeof sqliteAccount.$inferInsert>()
