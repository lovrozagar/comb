import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { generateMigrationFile } from "../../../src/migrate/core/atlas.ts"

describe("generateMigrationFile", () => {
	let tmpDir: string

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-atlas-test-"))
	})

	afterEach(() => {
		fs.rmSync(tmpDir, { force: true, recursive: true })
	})

	it("creates migration file with diff content", () => {
		const filepath = generateMigrationFile({
			diff: "CREATE TABLE users (id TEXT PRIMARY KEY);",
			migrationName: "init",
			migrationsDir: tmpDir,
		})

		expect(fs.existsSync(filepath)).toBe(true)
		const content = fs.readFileSync(filepath, "utf-8")
		expect(content).toContain("CREATE TABLE users")
		expect(content).toContain("Migration: init")
	})

	it("includes description when provided", () => {
		const filepath = generateMigrationFile({
			description: "Initial schema",
			diff: "CREATE TABLE users (id TEXT);",
			migrationName: "init",
			migrationsDir: tmpDir,
		})

		const content = fs.readFileSync(filepath, "utf-8")
		expect(content).toContain("Initial schema")
	})

	it("creates migrations dir if missing", () => {
		const nestedDir = path.join(tmpDir, "nested", "migrations")
		const filepath = generateMigrationFile({
			diff: "SELECT 1;",
			migrationName: "test",
			migrationsDir: nestedDir,
		})

		expect(fs.existsSync(filepath)).toBe(true)
	})

	it("generates timestamped filename", () => {
		const filepath = generateMigrationFile({
			diff: "SELECT 1;",
			migrationName: "add_users",
			migrationsDir: tmpDir,
		})

		const filename = path.basename(filepath)
		expect(filename).toMatch(/^\d{8}_add_users\.sql$/)
	})
})
