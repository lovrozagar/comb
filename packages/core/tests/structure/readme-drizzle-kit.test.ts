/**
 * README's `comb migrate` section warns a SQLite, libsql or Turso project off drizzle-kit migrate:
 * comb's `__drizzle_migrations` has no `applied_at`, the column drizzle-kit 1.0's migrate writes
 * there, so its migrate fails on comb's history. The sentence quotes the error, and the table comb
 * makes still lacks the column it names.
 */
import { describe, expect, it } from "vitest"
import { libsqlConnection } from "../../src/migrate/__fixtures__/libsql-connection.ts"
import { ensureMigrationsTable } from "../../src/migrate/core/apply.ts"
import { README } from "./support/readme.ts"

const MIGRATE = README.slice(README.indexOf("\n### `comb migrate`\n"), README.indexOf("\n## Columns\n"))

describe("README on drizzle-kit migrate over comb's SQLite history", () => {
	it("says drizzle-kit migrate fails on it, with the error it gives, and to apply with comb", () => {
		const said = MIGRATE.split("\n\n").find((paragraph) => paragraph.includes("drizzle-kit migrate")) ?? ""
		expect(said).toContain("`__drizzle_migrations`")
		expect(said).toContain('"no column named applied_at"')
		expect(said).toContain("`comb migrate apply`")
	})

	it("holds for the table comb makes: it has no applied_at", async () => {
		const conn = libsqlConnection()
		try {
			await ensureMigrationsTable(conn)
			const { rows } = await conn.execute("SELECT name FROM pragma_table_info('__drizzle_migrations')")
			expect(rows.map(([name]) => name)).not.toContain("applied_at")
		} finally {
			await conn.close()
		}
	})
})
