import { describe, expect, it } from "vitest"
import { kept, quote, renumberedBy, rowidCopy } from "./rebuild-rowids.ts"
import { extractSchema } from "./schema.ts"

const columns = (n: number): string => Array.from({ length: n }, (_, i) => `c${i + 1} text`).join(", ")

/* k: text-keyed, ki: keyed by its rowid, bare: no rowid, wide: 100 stored columns, gen: 99 stored and one generated */
const schema = extractSchema(`CREATE TABLE t (id text PRIMARY KEY, c1 text);
CREATE TABLE new_t (id text NOT NULL, c1 text NOT NULL, PRIMARY KEY (id));
CREATE TABLE ki (id integer PRIMARY KEY, c1 text);
CREATE TABLE bare (id text PRIMARY KEY, c1 text) WITHOUT ROWID;
CREATE TABLE wide (id text PRIMARY KEY, ${columns(99)});
CREATE TABLE gen (id text PRIMARY KEY, ${columns(98)}, g integer AS (1) VIRTUAL);`)

describe("kept", () => {
	it("carries a rowid apart only for a rowid table whose key is not its rowid, beside at most 99 columns", () => {
		expect(kept("t", schema, false)).toEqual({ columns: ["`id`", "`c1`"], rowid: true })
		expect(kept("ki", schema, false).rowid).toBe(false)
		expect(kept("bare", schema, false).rowid).toBe(false)
		expect(kept("wide", schema, false).rowid).toBe(false)
		expect(kept("gen", schema, false)).toMatchObject({ rowid: true })
		expect(kept("gen", schema, false).columns).toHaveLength(99)
	})

	it("carries every rowid table's rowid as comb 0.8 did", () => {
		expect(kept("ki", schema, true).rowid).toBe(true)
		expect(kept("wide", schema, true).rowid).toBe(true)
		expect(kept("bare", schema, true).rowid).toBe(false)
	})

	it("reads an unknown table as one with no columns", () => {
		expect(kept("gone", schema, false)).toEqual({ columns: [], rowid: false })
	})
})

describe("rowidCopy and renumberedBy", () => {
	const copy = "INSERT INTO `new_t` (`id`, `c1`) SELECT `id`, `c1` FROM `t`"

	it("rewrites the copy to carry the rowid, and names nothing renumbered", () => {
		expect(rowidCopy({ code: copy, stmt: copy }, { table: "t", temp: "new_t" }, schema)).toBe(
			"INSERT INTO `new_t` (rowid, `id`, `c1`) SELECT rowid, `id`, `c1` FROM `t`",
		)
		expect(renumberedBy({ table: "t", temp: "new_t" }, schema, { closure: ["ki", "wide"], code: copy })).toEqual([
			"wide gets new rowids (100 columns, no INTEGER PRIMARY KEY)",
		])
	})

	it("leaves the copy of an unknown table alone", () => {
		expect(rowidCopy({ code: copy, stmt: copy }, { table: "gone", temp: "new_t" }, schema)).toBeUndefined()
	})

	it("names a self-referencing copy by the rebuilt table", () => {
		expect(
			renumberedBy({ table: "t", temp: "wide" }, schema, {
				closure: ["wide"],
				code: "INSERT INTO wide (rowid) SELECT rowid FROM t",
			}),
		).toEqual(["t gets new rowids (100 columns, no INTEGER PRIMARY KEY)"])
	})

	it("quotes a name with a backtick in it", () => {
		expect(quote("a`b")).toBe("`a``b`")
	})
})
