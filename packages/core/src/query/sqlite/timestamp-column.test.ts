import { sql } from "drizzle-orm"
import { timestamp as pgTimestamp, pgTable } from "drizzle-orm/pg-core"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { describe, expect, it } from "vitest"
import { carriedText, holdsText, inMilliseconds, inSeconds } from "./timestamp-column.ts"

const post = sqliteTable("post", {
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
