import { describe, expect, it } from "vitest"
import { applySqliteMigrationTransforms, devUrl } from "./atlas-env.ts"

describe("devUrl", () => {
	it("names the ephemeral database atlas replays on, per dialect", () => {
		expect(devUrl("sqlite")).toBe("sqlite://file?mode=memory")
		expect(devUrl("postgres")).toBe("postgres://localhost:5432/dev?sslmode=disable")
	})
})

describe("applySqliteMigrationTransforms", () => {
	it("swaps atlas's foreign_keys off/on pair, comments included, for defer_foreign_keys", () => {
		const sql = [
			"-- Disable the enforcement of foreign-keys constraints",
			"PRAGMA foreign_keys = off;",
			"CREATE TABLE a (x);",
			"-- Enable back the enforcement of foreign-keys constraints",
			"PRAGMA foreign_keys = on;",
			"",
		].join("\n")
		expect(applySqliteMigrationTransforms(sql)).toBe("PRAGMA defer_foreign_keys = on;\nCREATE TABLE a (x);\n")
	})

	it("keeps the line break before a pragma that does not open the file", () => {
		expect(
			applySqliteMigrationTransforms("CREATE TABLE a (x);\nPRAGMA foreign_keys = off;\nCREATE TABLE b (y);\n"),
		).toBe("CREATE TABLE a (x);\nPRAGMA defer_foreign_keys = on;\nCREATE TABLE b (y);\n")
	})

	it("is idempotent and leaves SQL without the pragmas alone", () => {
		const once = applySqliteMigrationTransforms(
			"PRAGMA foreign_keys = off;\nCREATE TABLE a (x);\nPRAGMA foreign_keys = on;\n",
		)
		expect(applySqliteMigrationTransforms(once)).toBe(once)
		expect(applySqliteMigrationTransforms("CREATE TABLE a (x);")).toBe("CREATE TABLE a (x);")
	})
})
