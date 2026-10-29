import { describe, expect, it } from "vitest"
import { absentDatabase } from "./absent.ts"

describe("absentDatabase", () => {
	it("reads as an empty SQLite, column by column, and keeps its engine's prefix", async () => {
		const conn = await absentDatabase("core", "_cf_")
		expect(await conn.execute("SELECT count(*) AS n, ? AS x FROM sqlite_master", ["a"])).toEqual({
			columns: ["n", "x"],
			rows: [[0, "a"]],
		})
		expect(await conn.execute("SELECT name FROM sqlite_master")).toEqual({ columns: [], rows: [] })
		expect([conn.dialect, conn.ownedPrefix]).toEqual(["sqlite", "_cf_"])
		await conn.close()
	})

	it("refuses a write, naming the database", async () => {
		const conn = await absentDatabase("core")
		await expect(conn.batch([{ sql: "CREATE TABLE t (x)" }])).rejects.toThrow(
			"core does not exist yet; comb creates it only to apply to it",
		)
		await conn.close()
	})
})
