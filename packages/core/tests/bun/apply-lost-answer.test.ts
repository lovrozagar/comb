/// <reference types="bun-types" />
/**
 * S3 of r20 on bun:sqlite itself: a file whose batch committed and whose answer was lost, the
 * connection staying down, is unknown, not pending. src/migrate/core/apply.test.ts runs it on
 * libsql and on Node's SQLite in bun:sqlite's place.
 */
import { describe, expect, it } from "bun:test"
import { applyEach, ensureMigrationsTable } from "../../src/migrate/core/apply.ts"
import { Refused } from "../../src/migrate/core/refused.ts"
import { createBunSqliteProvider } from "../../src/migrate/drivers/bun-sqlite.ts"
import type { Connection } from "../../src/migrate/types.ts"

const DB = { migrationsDir: "m", name: "local", provider: { path: ":memory:", type: "bun-sqlite" as const } }

/** A lost connection as undici reports it: fetch failed, read ECONNRESET under it */
const reset = () =>
	new TypeError("fetch failed", { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) })

const file = (filename: string) => ({ filename, hash: filename, statements: [`CREATE TABLE "${filename}" (a)`] })

describe("applyEach on bun:sqlite when a committed batch's answer is lost", () => {
	it("reports the file unknown, the ones before it applied and the ones after it pending", async () => {
		const conn = await createBunSqliteProvider({ path: ":memory:", type: "bun-sqlite" }).connect(DB)
		await ensureMigrationsTable(conn)
		let down = false
		const losing: Connection = {
			...conn,
			batch: async (statements) => {
				if (down) throw reset()
				await conn.batch(statements)
				down = statements.some(({ params }) => params?.includes("0002_t2.sql") === true)
				if (down) throw reset()
			},
			execute: async (sql, params) => (down ? Promise.reject(reset()) : conn.execute(sql, params)),
		}
		const files = ["0001_t1.sql", "0002_t2.sql", "0003_t3.sql"].map(file)
		const failure = await applyEach(() => Promise.resolve({ ...losing, close: () => Promise.resolve() }), files, {
			print: () => {},
			retry: { baseDelay: 0, maxDelay: 0 },
		}).catch((error: unknown) => error)
		expect(failure).toBeInstanceOf(Refused)
		const { applied, pending, unknown } = failure as Refused
		expect({ applied, pending, unknown }).toEqual({
			applied: ["0001_t1.sql"],
			pending: ["0003_t3.sql"],
			unknown: ["0002_t2.sql"],
		})
		expect((await conn.execute("SELECT name FROM __drizzle_migrations ORDER BY id")).rows).toEqual([
			["0001_t1.sql"],
			["0002_t2.sql"],
		])
		await conn.close()
	})
})
