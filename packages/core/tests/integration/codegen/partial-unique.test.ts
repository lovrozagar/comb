import { fixtureRoot } from "../../../src/codegen/__fixtures__/temp.ts"
/**
 * A partial unique index (`.where()`) is no column uniqueness, so the published entity meta leaves
 * it out; but SQLite reports its violation as "UNIQUE constraint failed: <table>.<column>" like any
 * other, so the generated constraint map must still map it. Both are checked on one generated
 * table, the violation on libsql (found by the 0.5.0 monorepo regeneration: anyrow's
 * idx_user_email_unique lost user_email_duplicate).
 */
import fs from "node:fs"
import path from "node:path"
import { sql } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { analyze } from "../../../src/codegen/analyzer.ts"
import type { TableMeta } from "../../../src/codegen/analyzer-types.ts"
import { deriveEntityMeta } from "../../../src/codegen/entity-meta.ts"
import { generateConstraints } from "../../../src/codegen/generators/constraints.ts"
import { testContext } from "../../../src/codegen/generators/__fixtures__/context.ts"
import type { CombError } from "../../../src/error.ts"
import { sqliteErrorHandler } from "../../../src/sqlite/constraint-handler.ts"
import type { ConstraintMap } from "../../../src/types.ts"
import { libsqlMemory } from "../support/libsql.ts"

const TABLES = `
import { sql } from "drizzle-orm"
import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { c } from "@lovrozagar/comb/sqlite/columns"
export const user = sqliteTable("user", {
	id: c.id("usr"),
	email: c.text("email"),
	deleted_at: c.text("deleted_at"),
}, (t) => [uniqueIndex("idx_user_email_unique").on(t.email).where(sql\`deleted_at IS NULL\`)])
`

const DDL = `
	CREATE TABLE user (id TEXT PRIMARY KEY, email TEXT, deleted_at TEXT);
	CREATE UNIQUE INDEX idx_user_email_unique ON user (email) WHERE deleted_at IS NULL;
	INSERT INTO user VALUES ('u1', 'ada@example.com', NULL);
	INSERT INTO user VALUES ('u0', 'ada@example.com', '2026-01-01');
`

let dir: string
let table: TableMeta
let map: ConstraintMap

beforeAll(async () => {
	dir = fs.mkdtempSync(path.join(fixtureRoot(), "comb-partial-unique-"))
	const tables = path.join(dir, "db.app.tables.ts")
	fs.writeFileSync(tables, TABLES)
	const analysis = analyze(tables)
	table = analysis.tables[0] as TableMeta
	const output = path.join(dir, "constraints.gen.ts")
	generateConstraints(testContext(analysis, { cwd: dir }), { output })
	map = ((await import(output)) as Record<string, ConstraintMap>).APP_DB_CONSTRAINT_MAP as ConstraintMap
})

afterAll(() => fs.rmSync(dir, { force: true, recursive: true }))

describe("a partial unique index", () => {
	it("is not published as column uniqueness", () => {
		expect(table.uniqueIndexes).toEqual([])
		expect(deriveEntityMeta(table)?.uniqueIndexes).toEqual([])
	})

	/* C7 of the 0.14.1 review: published apart, so a reader that knows no predicate claims no uniqueness */
	it("is published apart, with the predicate its uniqueness holds under", () => {
		expect(deriveEntityMeta(table)?.partialUniqueIndexes).toEqual([
			{ columns: ["email"], name: "idx_user_email_unique", where: "deleted_at IS NULL" },
		])
	})

	it("is in the generated constraint map with its error key", () => {
		expect(map.user?.unique?.email?.errorKey).toBe("user_email_duplicate")
	})

	it("maps the engine's violation on libsql to that key", async () => {
		const { client, close, db } = libsqlMemory()
		try {
			await client.executeMultiple(DDL)
			const failure = await db.run(sql.raw("INSERT INTO user VALUES ('u2', 'ada@example.com', NULL)")).then(
				() => null,
				(error: unknown) => error,
			)
			expect(() => sqliteErrorHandler(failure, [map])).toThrow(
				expect.objectContaining({ errorKey: "user_email_duplicate" }) as CombError,
			)
		} finally {
			close()
		}
	})
})
