import { describe, expect, it, vi } from "vitest"
import { libsql } from "./libsql-client.ts"

describe("libsql", () => {
	it("loads @libsql/client", async () => {
		expect(typeof (await libsql()).createClient).toBe("function")
	})

	it("refuses, naming the package, its range and why, when the peer is missing", async () => {
		vi.doMock("@libsql/client", () => {
			throw new Error("Cannot find package '@libsql/client'")
		})
		vi.resetModules()
		try {
			const { libsql: missing } = await import("./libsql-client.ts")
			await expect(missing()).rejects.toThrow(
				"comb needs @libsql/client (>=0.17.4 <0.18) to open a libsql or Turso database; install @libsql/client",
			)
		} finally {
			vi.doUnmock("@libsql/client")
		}
	})
})
