import { sql } from "drizzle-orm"
import { timestamp as pgTimestamp, pgTable } from "drizzle-orm/pg-core"
import { blob, customType, integer, numeric, real, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { describe, expect, it } from "vitest"
import {
	carriedStored,
	carriedText,
	heldApart,
	holdsText,
	inMilliseconds,
	inSeconds,
	storedReads,
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
	it("takes a string the cursor flags as carried on a Postgres date-mode time read back", () => {
		expect(carriedText(pgPost.at, "2024-01-01T00:00:00.123456+00:00", { asRead: false, carried: true })).toBe(true)
	})

	it("takes nothing unflagged, bound as read, that is no string, or on a SQLite column, whose value carriedStored takes", () => {
		expect(carriedText(pgPost.at, "x", { asRead: false, carried: false })).toBe(false)
		expect(carriedText(pgPost.at, "x", { asRead: true, carried: true })).toBe(false)
		expect(carriedText(pgPost.at, 1_700_000_000, { asRead: false, carried: true })).toBe(false)
		expect(carriedText(post.s, "2024-01-01 00:00:00", { asRead: false, carried: true })).toBe(false)
		expect(carriedText(sql`now()`, "x", { asRead: false, carried: true })).toBe(false)
	})
})

const modes = sqliteTable("modes", {
	big: blob("big", { mode: "bigint" }),
	buffer: blob("buffer", { mode: "buffer" }),
	custom: customType<{ data: string }>({ dataType: () => "text" })("custom"),
	json: text("json", { mode: "json" }),
	num: numeric("num"),
	real: real("real"),
})

/* AB4-2 of area B: each SQLite mode reads back as stored a set of storage classes, and carries any other apart */
describe("a SQLite key's stored value its mode reads as another (AB3-2, AB4-2 of area B; sibling: carriedText)", () => {
	it("names the classes each mode reads back as stored, and none for a JSON, custom or Postgres column", () => {
		const columns = [post.b, post.n, post.s, post.label, modes.real, modes.num, modes.buffer, modes.big]
		expect(columns.map(storedReads)).toEqual([
			"boolean",
			["integer", "real"],
			["integer", "real"],
			["text"],
			["integer", "real"],
			["integer", "finite"],
			["blob"],
			["blob"],
		])
		expect([modes.json, modes.custom, pgPost.at, sql`${post.n}`, undefined].map(storedReads)).toEqual([
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
		])
	})

	it("holds apart a key of a mode with a set alone", () => {
		expect(
			[post.b, post.s, post.label, modes.num, modes.json, modes.custom, pgPost.at, undefined].map(heldApart),
		).toEqual([true, true, true, true, false, false, false, false])
	})

	it("takes a number, a bigint, a TEXT or a blob's bytes the cursor flags as carried on a key read back", () => {
		for (const value of [-1, 2n ** 60n, "yes", Uint8Array.of(1)])
			expect(carriedStored(post.b, value, { asRead: false, carried: true }), String(value)).toBe(true)
		expect(carriedStored(post.s, "2024-01-01 00:00:00", { asRead: false, carried: true })).toBe(true)
	})

	it("takes nothing unflagged, bound as read, of another type, or on a column with no set", () => {
		expect(carriedStored(post.b, 2, { asRead: false, carried: false })).toBe(false)
		expect(carriedStored(post.b, 2, { asRead: true, carried: true })).toBe(false)
		expect(carriedStored(post.b, true, { asRead: false, carried: true })).toBe(false)
		expect(carriedStored(post.b, null, { asRead: false, carried: true })).toBe(false)
		expect(carriedStored(modes.json, "2", { asRead: false, carried: true })).toBe(false)
	})
})
