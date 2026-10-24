import { fixtureRoot } from "../../../src/codegen/__fixtures__/temp.ts"
/**
 * A column's SQL name is what the engine reports and what triggers reference, so everything
 * comb generates for the engine keys on it, not on the TypeScript property that holds it.
 * Here every property differs from its column, and the generated map and FTS DDL run on libsql.
 */
import fs from "node:fs"
import path from "node:path"
import { sql } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { analyze } from "../../../src/codegen/analyzer.ts"
import type { AnalysisResult } from "../../../src/codegen/analyzer-types.ts"
import { generateConstraints } from "../../../src/codegen/generators/constraints.ts"
import { generateFtsSql } from "../../../src/codegen/generators/fts-sql.ts"
import type { CombError } from "../../../src/error.ts"
import { sqliteErrorHandler } from "../../../src/sqlite/constraint-handler.ts"
import type { ConstraintMap } from "../../../src/types.ts"
import { libsqlMemory } from "../support/libsql.ts"
import { testContext } from "../../../src/codegen/generators/__fixtures__/context.ts"

const TABLES = `
import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { c } from "@lovrozagar/comb/sqlite/columns"
export const owner = sqliteTable("owner", { id: c.id("own") })
export const member = sqliteTable("member", {
	id: c.id("mem"),
	displayName: c.text("display_name").unique(),
	ownerId: c.ref("owner_id").references(() => owner.id),
	slugText: c.text("slug"),
	bodyText: c.text("body_text"),
}, (t) => [uniqueIndex("member_slug_idx").on(t.slugText)])
`

const DDL = `
	PRAGMA foreign_keys = ON;
	CREATE TABLE owner (id TEXT PRIMARY KEY);
	CREATE TABLE member (
		id TEXT PRIMARY KEY,
		display_name TEXT UNIQUE,
		owner_id TEXT REFERENCES owner(id),
		slug TEXT,
		body_text TEXT
	);
	CREATE UNIQUE INDEX member_slug_idx ON member (slug);
	INSERT INTO owner VALUES ('o1');
	INSERT INTO member (id, display_name, owner_id, slug, body_text) VALUES ('m1', 'Ada', 'o1', 'ada', 'hello world');
`

let dir: string
let analysis: AnalysisResult
let map: ConstraintMap

beforeAll(async () => {
	dir = fs.mkdtempSync(path.join(fixtureRoot(), "comb-sql-names-"))
	const tables = path.join(dir, "db.app.tables.ts")
	fs.writeFileSync(tables, TABLES)
	analysis = analyze(tables)
	const output = path.join(dir, "constraints.gen.ts")
	generateConstraints(testContext(analysis, { cwd: dir }), { output })
	map = ((await import(output)) as Record<string, ConstraintMap>).APP_DB_CONSTRAINT_MAP as ConstraintMap
})

afterAll(() => fs.rmSync(dir, { force: true, recursive: true }))

describe("FieldMeta.sqlName", () => {
	it("is the column's own name: c.id → id, the first string argument otherwise", () => {
		const member = analysis.tables.find((table) => table.varName === "member")
		expect(member?.fields.map((field) => [field.name, field.sqlName])).toEqual([
			["id", "id"],
			["displayName", "display_name"],
			["ownerId", "owner_id"],
			["slugText", "slug"],
			["bodyText", "body_text"],
		])
	})
})

describe("generated constraint map on libsql", () => {
	it("keys unique and foreign key entries on the SQL column; error keys keep the property name", () => {
		expect(Object.keys(map.member?.unique ?? {}).sort()).toEqual(["display_name", "slug"])
		expect(Object.keys(map.member?.foreignKey ?? {})).toEqual(["owner_id"])
		expect(map.member?.unique?.display_name?.errorKey).toBe("member_displayName_duplicate")
	})

	it.each([
		["INSERT INTO member (id, display_name) VALUES ('m2', 'Ada')", "member_displayName_duplicate"],
		["INSERT INTO member (id, slug) VALUES ('m3', 'ada')", "member_slugText_duplicate"],
		["INSERT INTO member (id, owner_id) VALUES ('m4', 'nope')", "member_ownerId_reference_not_found"],
	])("maps the engine's error for %s", async (statement, errorKey) => {
		const { client, close, db } = libsqlMemory()
		try {
			await client.executeMultiple(DDL)
			const failure = await db.run(sql.raw(statement)).then(
				() => null,
				(error: unknown) => error,
			)
			expect(() => sqliteErrorHandler(failure, [map])).toThrow(expect.objectContaining({ errorKey }) as CombError)
		} finally {
			close()
		}
	})
})

describe("generated FTS SQL on libsql", () => {
	it("indexes rows through triggers that name the SQL columns", async () => {
		const fts = generateFtsSql(analysis.tables, { member: { columns: ["displayName", "bodyText"] } }, () => undefined)
		const { client, close } = libsqlMemory()
		try {
			await client.executeMultiple(DDL.replace(/INSERT INTO member[^;]*;/, ""))
			await client.executeMultiple(fts)
			await client.execute("INSERT INTO member (id, display_name, body_text) VALUES ('m1', 'Ada', 'hello world')")
			await client.execute("UPDATE member SET body_text = 'goodbye moon' WHERE id = 'm1'")
			const hits = await client.execute("SELECT rowid FROM member_fts WHERE member_fts MATCH 'goodbye'")
			const stale = await client.execute("SELECT rowid FROM member_fts WHERE member_fts MATCH 'hello'")
			expect([hits.rows.length, stale.rows.length]).toEqual([1, 0])
		} finally {
			close()
		}
	})
})
