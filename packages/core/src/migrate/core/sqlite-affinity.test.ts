import { describe, expect, it } from "vitest"
import type { TableInfo } from "../types.ts"
import { affinityOf, conflictsOf, definitionAffinity, definitionDrift, isStrict } from "./sqlite-affinity.ts"

describe("affinityOf", () => {
	it.each([
		["INTEGER", "INTEGER"],
		["bigint", "INTEGER"],
		["varchar(255)", "TEXT"],
		["CLOB", "TEXT"],
		["", "BLOB"],
		["blob", "BLOB"],
		["DOUBLE PRECISION", "REAL"],
		["float", "REAL"],
		["decimal(10,2)", "NUMERIC"],
		["boolean", "NUMERIC"],
	])("reads %j as %s, by SQLite's rules", (type, affinity) => {
		expect(affinityOf(type)).toBe(affinity)
	})

	it("reads a column definition's type only up to its first constraint", () => {
		expect(definitionAffinity("text NOT NULL DEFAULT 'int'")).toBe("TEXT")
		expect(definitionAffinity("REFERENCES u(id)")).toBe("BLOB")
	})
})

describe("conflictsOf and isStrict", () => {
	it("names each non-ABORT resolution by its column, or a table constraint by its key", () => {
		expect(conflictsOf("code TEXT NOT NULL ON CONFLICT ignore UNIQUE ON CONFLICT REPLACE", "code")).toEqual([
			"code: IGNORE",
			"code: REPLACE",
		])
		expect(conflictsOf("UNIQUE (a, b) ON CONFLICT FAIL", undefined)).toEqual(["a,b: FAIL"])
		expect(conflictsOf("CHECK (x > 0) ON CONFLICT ROLLBACK", undefined)).toEqual(["x>0: ROLLBACK"])
		expect(conflictsOf("x TEXT ON CONFLICT ABORT", "x")).toEqual([])
	})

	it("reads STRICT after the column list only", () => {
		expect(isStrict("CREATE TABLE t (a TEXT) STRICT")).toBe(true)
		expect(isStrict("CREATE TABLE t (a TEXT) WITHOUT ROWID, STRICT")).toBe(true)
		expect(isStrict("CREATE TABLE t (strict TEXT)")).toBe(false)
	})
})

/** A table's shape with these affinities, resolutions and STRICT */
const table = (affinity: Record<string, string>, conflicts: string[] = [], strict = false): TableInfo => ({
	affinity,
	autoincrement: false,
	conflicts,
	generatedColumns: [],
	primaryKey: [],
	rowidAlias: false,
	strict,
	withoutRowid: false,
})

describe("definitionDrift", () => {
	it("names a changed affinity, an added resolution, and STRICT, in that order, for the copied columns only", () => {
		expect(definitionDrift(table({ a: "TEXT" }), table({ a: "INTEGER" }), ["a"])).toContain(
			"changes a's affinity from TEXT to INTEGER",
		)
		expect(definitionDrift(table({ a: "TEXT" }), table({}), ["a"])).toContain("from TEXT to BLOB")
		expect(definitionDrift(table({}), table({ a: "TEXT" }), ["a"])).toContain("from BLOB to TEXT")
		expect(definitionDrift(table({ a: "TEXT" }), table({ a: "TEXT" }, ["a: IGNORE"]), ["a"])).toContain(
			"adds ON CONFLICT a: IGNORE",
		)
		expect(
			definitionDrift(table({ a: "TEXT" }, ["a: IGNORE"]), table({ a: "TEXT" }, ["a: IGNORE"]), ["a"]),
		).toBeUndefined()
		expect(definitionDrift(table({}), table({}, [], true), [])).toContain("makes the table STRICT")
		expect(definitionDrift(table({}, [], true), table({}, [], true), [])).toBeUndefined()
		expect(definitionDrift(table({ b: "TEXT" }), table({ b: "INTEGER" }), ["a"])).toBeUndefined()
	})
})
