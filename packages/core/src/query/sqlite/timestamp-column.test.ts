import { sql } from "drizzle-orm"
import { timestamp as pgTimestamp, pgTable } from "drizzle-orm/pg-core"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { describe, expect, it } from "vitest"
import {
	carriedStored,
	carriedText,
	heldApart,
	holdsText,
	inBoolean,
	inMilliseconds,
	inSeconds,
} from "./timestamp-column.ts"

const post = sqliteTable("post", {
	b: integer("b", { mode: "boolean" }),
	label: text("label"),
	m: integer("m", { mode: "timestamp_ms" }),
	n: integer("n"),
	s: integer("s", { mode: "timestamp" }),
})
const pgPost = pgTable("pg_post", { at: pgTimestamp("at") })

describe("SQLite's timestamp columns, by mode", () => {
	it("tells a seconds-mode timestamp from a milliseconds-mode one, and from any other column or expression", () => {
		expect([post.s, post.m, post.n, post.label, pgPost.at, sql`${post.s}`, undefined].map(inSeconds)).toEqual([
			true,
			false,
			false,
			false,
			false,
			false,
			false,
		])
		expect([post.s, post.m, post.n, pgPost.at, undefined].map(inMilliseconds)).toEqual([
			false,
			true,
			false,
			false,
			false,
		])
	})

	it("holds TEXT in either mode of SQLite timestamp alone", () => {
		expect([post.s, post.m, post.n, post.label, pgPost.at, sql`${post.m}`].map(holdsText)).toEqual([
			true,
			true,
			false,
			false,
			false,
			false,
		])
	})
})

describe("carriedText", () => {
	it("takes a string the cursor flags as carried on a timestamp read back", () => {
		expect(carriedText(post.s, "2024-01-01 00:00:00", { asRead: false, carried: true })).toBe(true)
		expect(carriedText(post.m, "b,text", { asRead: false, carried: true })).toBe(true)
	})

	it("takes nothing unflagged, bound as read, that is no string, or on another column", () => {
		expect(carriedText(post.s, "x", { asRead: false, carried: false })).toBe(false)
		expect(carriedText(post.s, "x", { asRead: true, carried: true })).toBe(false)
		expect(carriedText(post.s, 1_700_000_000, { asRead: false, carried: true })).toBe(false)
		expect(carriedText(post.n, "x", { asRead: false, carried: true })).toBe(false)
	})
})

/* AB3-2 of area B: drizzle's boolean mode reads every value but 1 as false */
describe("a SQLite boolean's stored value (AB3-2 of area B; sibling: carriedText)", () => {
	it("tells a boolean column from any other, and holds apart a boolean's or a timestamp's stored value alone", () => {
		expect([post.b, post.n, post.s, sql`${post.b}`, undefined].map(inBoolean)).toEqual([
			true,
			false,
			false,
			false,
			false,
		])
		expect([post.b, post.s, post.m, post.n, post.label, undefined].map(heldApart)).toEqual([
			true,
			true,
			true,
			false,
			false,
			false,
		])
	})

	it("takes a number, a bigint, a TEXT or a blob's bytes the cursor flags as carried on a boolean read back", () => {
		for (const value of [-1, 2n ** 60n, "yes", Uint8Array.of(1)])
			expect(carriedStored(post.b, value, { asRead: false, carried: true }), String(value)).toBe(true)
	})

	it("takes nothing unflagged, bound as read, of another type, or on another column", () => {
		expect(carriedStored(post.b, 2, { asRead: false, carried: false })).toBe(false)
		expect(carriedStored(post.b, 2, { asRead: true, carried: true })).toBe(false)
		expect(carriedStored(post.b, true, { asRead: false, carried: true })).toBe(false)
		expect(carriedStored(post.b, null, { asRead: false, carried: true })).toBe(false)
		expect(carriedStored(post.n, 2, { asRead: false, carried: true })).toBe(false)
	})
})
