import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { generateOrm } from "../../../../src/codegen/generators/orm.ts"

describe("generateOrm", () => {
	let tmpDir: string

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-gen-orm-"))
	})

	afterEach(() => {
		fs.rmSync(tmpDir, { force: true, recursive: true })
	})

	it("generates D1 ORM client", () => {
		const tablesPath = path.join(tmpDir, "db.core.tables.ts")
		fs.writeFileSync(tablesPath, "")
		const outputPath = path.join(tmpDir, "orm.gen.ts")

		generateOrm(
			tablesPath,
			{
				dialect: "sqlite",
				driver: "d1",
				output: outputPath,
			},
			tmpDir,
		)

		const content = fs.readFileSync(outputPath, "utf-8")
		expect(content).toContain("createCoreDb")
		expect(content).toContain("d1: AnyD1Database")
		expect(content).toContain("drizzle-orm/d1")
		expect(content).toContain("type CoreDb")
		expect(content).toContain("type CoreSchema")
	})

	it("generates Turso ORM client with caching", () => {
		const tablesPath = path.join(tmpDir, "db.auth.tables.ts")
		fs.writeFileSync(tablesPath, "")
		const outputPath = path.join(tmpDir, "orm.gen.ts")

		generateOrm(
			tablesPath,
			{
				dialect: "sqlite",
				driver: "turso",
				output: outputPath,
			},
			tmpDir,
		)

		const content = fs.readFileSync(outputPath, "utf-8")
		expect(content).toContain("createAuthDb")
		expect(content).toContain("createAuthDbHttp")
		expect(content).toContain("createAuthDbWeb")
		expect(content).toContain("authDbIsolateCache")
		expect(content).toContain("@libsql/client")
	})

	it("generates libsql ORM client", () => {
		const tablesPath = path.join(tmpDir, "db.local.tables.ts")
		fs.writeFileSync(tablesPath, "")
		const outputPath = path.join(tmpDir, "orm.gen.ts")

		generateOrm(
			tablesPath,
			{
				dialect: "sqlite",
				driver: "libsql",
				output: outputPath,
			},
			tmpDir,
		)

		const content = fs.readFileSync(outputPath, "utf-8")
		expect(content).toContain("createLocalDb")
		expect(content).toContain("createClient")
	})

	it("generates Neon ORM client", () => {
		const tablesPath = path.join(tmpDir, "db.analytics.tables.ts")
		fs.writeFileSync(tablesPath, "")
		const outputPath = path.join(tmpDir, "orm.gen.ts")

		generateOrm(
			tablesPath,
			{
				dialect: "postgres",
				driver: "neon",
				output: outputPath,
			},
			tmpDir,
		)

		const content = fs.readFileSync(outputPath, "utf-8")
		expect(content).toContain("createAnalyticsDbHttp")
		expect(content).toContain("createAnalyticsDbPool")
		expect(content).toContain("@neondatabase/serverless")
	})

	it("throws for unsupported driver", () => {
		const tablesPath = path.join(tmpDir, "db.test.tables.ts")
		fs.writeFileSync(tablesPath, "")

		expect(() =>
			generateOrm(
				tablesPath,
				{
					dialect: "sqlite",
					driver: "better-sqlite3" as "d1",
					output: path.join(tmpDir, "out.ts"),
				},
				tmpDir,
			),
		).toThrow("Unsupported SQLite driver")
	})

	it("uses custom relations output path", () => {
		const tablesPath = path.join(tmpDir, "db.core.tables.ts")
		fs.writeFileSync(tablesPath, "")
		const outputPath = path.join(tmpDir, "orm.gen.ts")

		generateOrm(
			tablesPath,
			{
				dialect: "sqlite",
				driver: "d1",
				output: outputPath,
				relationsOutput: "./src/custom.relations.gen.ts",
			},
			tmpDir,
		)

		const content = fs.readFileSync(outputPath, "utf-8")
		expect(content).toContain("./custom.relations.gen")
	})
})

describe("generateOrm — remaining drivers", () => {
	let tmpDir: string

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-orm-drivers-"))
	})

	afterEach(() => {
		fs.rmSync(tmpDir, { force: true, recursive: true })
	})

	function generate(config: { dialect: "postgres" | "sqlite"; driver: string }): string {
		const tablesPath = path.join(tmpDir, "db.core.tables.ts")
		fs.writeFileSync(tablesPath, "")
		const outputPath = path.join(tmpDir, "orm.gen.ts")
		generateOrm(tablesPath, { ...config, output: outputPath } as never, tmpDir)
		return fs.readFileSync(outputPath, "utf-8")
	}

	it("generates a bun:sqlite client taking a file path", () => {
		const content = generate({ dialect: "sqlite", driver: "bun-sqlite" })
		expect(content).toContain(`import { Database } from "bun:sqlite"`)
		expect(content).toContain("drizzle-orm/bun-sqlite")
		expect(content).toContain("createCoreDb(path: string)")
		expect(content).toContain("new Database(path)")
	})

	it("generates a libsql client", () => {
		const content = generate({ dialect: "sqlite", driver: "libsql" })
		expect(content).toContain("@libsql/client")
		expect(content).toContain("createCoreDb")
	})

	it("generates a neon client for postgres", () => {
		const content = generate({ dialect: "postgres", driver: "neon" })
		expect(content).toContain("@neondatabase/serverless")
		expect(content).toContain("createCoreDb")
	})

	it("refuses an unknown sqlite driver by name", () => {
		expect(() => generate({ dialect: "sqlite", driver: "mystery" })).toThrow(/Unsupported SQLite driver: mystery/)
	})

	it("refuses an unknown postgres driver by name", () => {
		expect(() => generate({ dialect: "postgres", driver: "mystery" })).toThrow(/Unsupported Postgres driver: mystery/)
	})
})
