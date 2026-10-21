import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("./bun-sqlite.ts", () => ({ openBunMemory: vi.fn(async () => ({ bun: true })) }))

const bunVersion = Object.getOwnPropertyDescriptor(process.versions, "bun")
afterEach(() => {
	if (bunVersion === undefined) Reflect.deleteProperty(process.versions, "bun")
	else Object.defineProperty(process.versions, "bun", bunVersion)
})

describe("openMemory", () => {
	it("opens node:sqlite under Node: statements, rows and parameters", async () => {
		const { openMemory } = await import("./memory.ts")
		const db = await openMemory()
		db.exec("CREATE TABLE t (a TEXT); CREATE TABLE u (b TEXT)")
		db.run("INSERT INTO t VALUES (?)", ["007"])
		db.run("INSERT INTO t VALUES ('x')")
		expect(db.all("SELECT a, typeof(a) AS t FROM t WHERE a = ?", ["007"])).toEqual([{ a: "007", t: "text" }])
		expect(db.all("SELECT count(*) AS n FROM t")).toEqual([{ n: 2 }])
		db.close()
	})

	it("opens bun:sqlite's under Bun", async () => {
		Object.defineProperty(process.versions, "bun", { configurable: true, value: "1.3.11" })
		const { openMemory } = await import("./memory.ts")
		expect(await openMemory()).toEqual({ bun: true })
	})
})
