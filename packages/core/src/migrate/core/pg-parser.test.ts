import { describe, expect, it, vi } from "vitest"
import { loadPostgresParser, postgresParser } from "./pg-parser.ts"

describe("loading the Postgres parser", () => {
	it("says to install libpg-query when it is not installed", async () => {
		vi.resetModules()
		vi.doMock("libpg-query", () => {
			throw new Error("Cannot find package 'libpg-query'")
		})
		const fresh = await import("./pg-parser.ts")
		await expect(fresh.loadPostgresParser()).rejects.toThrow(/install libpg-query@17\.7\.4/)
		vi.doUnmock("libpg-query")
	})

	it("loads it once", async () => {
		await expect(loadPostgresParser()).resolves.toBeUndefined()
	})
})

describe("the loaded parser", () => {
	it("parses, once loaded", async () => {
		await loadPostgresParser()
		expect(postgresParser().parseSync("SELECT 1").stmts).toHaveLength(1)
	})
})
