/**
 * Generated enum CHECKs, imported and run on SQLite. A value may hold any character a string
 * can: the generated `sql` template and the SQL literal inside it must both keep it intact.
 */
import fs from "node:fs"
import path from "node:path"
import { type SQL, sql } from "drizzle-orm"
import { SQLiteDialect, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { afterAll, describe, expect, it } from "vitest"
import type { FieldMeta, TableMeta } from "../../../src/codegen/analyzer-types.ts"
import { parseField } from "../../../src/codegen/__fixtures__/runtime.ts"
import { generateEnumChecks } from "../../../src/codegen/generators/enum-checks.ts"
import { libsqlMemory } from "../support/libsql.ts"
import { testContext } from "../../../src/codegen/generators/__fixtures__/context.ts"

const DIR = path.resolve(import.meta.dirname, `.tmp-dtos/enum-checks-${process.pid}`)
afterAll(() => fs.rmSync(DIR, { force: true, recursive: true }))

const VALUES = ["plain", "it's", "back`tick", "dollar ${brace}", "back\\slash", "new\nline"]

const dialect = new (SQLiteDialect as unknown as new () => {
	sqlToQuery: (s: SQL) => { params: unknown[]; sql: string }
})()

describe("generateEnumChecks", () => {
	it("emits a CHECK SQLite runs, that admits exactly the declared values", async () => {
		const field: FieldMeta = {
			...parseField("status", 'c.enum("status", VALUES)', { scope: { VALUES } }),
			enumValues: VALUES,
		}
		const table: TableMeta = {
			checkConstraints: [],
			expressionIndexes: [],
			schema: null,
			fields: [parseField("id", 'c.id("itm")'), field],
			hasCompositePrimaryKey: false,
			idPrefix: "itm",
			sqlName: "item",
			timestamps: {
				createdAt: false,
				deletedAt: false,
				names: { createdAt: null, deletedAt: null, updatedAt: null },
				style: "snake_case",
				updatedAt: false,
			},
			partialUniqueIndexes: [],
			uniqueIndexes: [],
			varName: "item",
		}
		const output = path.join(DIR, "enum-checks.gen.ts")
		generateEnumChecks(testContext([table], { cwd: DIR, dbName: "x" }), { output })
		const generated = (await import(output)) as Record<string, (t: Record<string, unknown>) => Array<{ value: SQL }>>
		const columns = sqliteTable("item", { id: text("id").primaryKey(), status: text("status") })
		const checks = Object.values(generated).find((v) => typeof v === "function")?.(columns as never) ?? []
		expect(checks).toHaveLength(1)
		const rendered = dialect.sqlToQuery(sql`${checks[0]!.value}`)
		expect(rendered.params).toEqual([])

		const { client, close } = libsqlMemory()
		try {
			await client.execute(`CREATE TABLE item (id TEXT PRIMARY KEY, status TEXT CHECK (${rendered.sql}))`)
			for (const [i, value] of VALUES.entries()) {
				await client.execute({ args: [`i${i}`, value], sql: "INSERT INTO item VALUES (?, ?)" })
			}
			await expect(client.execute({ args: ["bad", "back"], sql: "INSERT INTO item VALUES (?, ?)" })).rejects.toThrow(
				/CHECK constraint failed/,
			)
		} finally {
			close()
		}
	})
})
