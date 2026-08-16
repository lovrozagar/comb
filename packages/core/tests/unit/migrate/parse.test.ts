import { describe, expect, it } from "vitest"
import {
	classifyMigration,
	extractDropStatements,
	extractSchema,
	generateMigrationHash,
	makeIdempotent,
	parseMigration,
	splitSqlStatements,
} from "../../../src/migrate/core/parse.ts"

describe("splitSqlStatements", () => {
	it("splits simple statements on semicolons", () => {
		const result = splitSqlStatements("CREATE TABLE a (id TEXT); CREATE TABLE b (id TEXT);")
		expect(result).toHaveLength(2)
		expect(result[0]).toContain("CREATE TABLE a")
		expect(result[1]).toContain("CREATE TABLE b")
	})

	it("ignores semicolons inside string literals", () => {
		const result = splitSqlStatements("INSERT INTO a VALUES ('hello; world');")
		expect(result).toHaveLength(1)
		expect(result[0]).toContain("hello; world")
	})

	it("handles empty input", () => {
		expect(splitSqlStatements("")).toHaveLength(0)
		expect(splitSqlStatements("   ")).toHaveLength(0)
	})

	it("strips SQL comments", () => {
		const result = splitSqlStatements(`
-- this is a comment
CREATE TABLE a (id TEXT);
/* block comment */
CREATE TABLE b (id TEXT);
`)
		expect(result).toHaveLength(2)
	})
})

describe("generateMigrationHash", () => {
	it("produces consistent hash for same SQL", () => {
		const sql = "CREATE TABLE a (id TEXT PRIMARY KEY);"
		expect(generateMigrationHash(sql)).toBe(generateMigrationHash(sql))
	})

	it("ignores whitespace differences", () => {
		const sql1 = "CREATE TABLE a (id TEXT);"
		const sql2 = "CREATE  TABLE  a  (id  TEXT);"
		expect(generateMigrationHash(sql1)).toBe(generateMigrationHash(sql2))
	})

	it("ignores comment differences", () => {
		const sql1 = "CREATE TABLE a (id TEXT);"
		const sql2 = "-- comment\nCREATE TABLE a (id TEXT);"
		expect(generateMigrationHash(sql1)).toBe(generateMigrationHash(sql2))
	})

	it("produces different hash for different SQL", () => {
		expect(generateMigrationHash("CREATE TABLE a (id TEXT);")).not.toBe(
			generateMigrationHash("CREATE TABLE b (id TEXT);"),
		)
	})
})

describe("extractSchema", () => {
	it("extracts tables and columns from CREATE TABLE", () => {
		const schema = extractSchema(`
CREATE TABLE user (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT
);
`)
		expect(schema.tables.get("user")).toEqual(["id", "name", "email"])
	})

	it("handles multiple tables", () => {
		const schema = extractSchema(`
CREATE TABLE user (id TEXT PRIMARY KEY);
CREATE TABLE post (id TEXT PRIMARY KEY, title TEXT);
`)
		expect(schema.tables.has("user")).toBe(true)
		expect(schema.tables.has("post")).toBe(true)
		expect(schema.tables.get("post")).toContain("title")
	})

	it("tracks dropped tables", () => {
		const schema = extractSchema("DROP TABLE IF EXISTS old_table;")
		expect(schema.droppedTables).toContain("old_table")
	})

	it("extracts indexes", () => {
		const schema = extractSchema(`
CREATE TABLE user (id TEXT PRIMARY KEY, email TEXT);
CREATE INDEX idx_email ON user (email);
CREATE UNIQUE INDEX idx_email_unique ON user (email);
`)
		expect(schema.indexes).toContain("idx_email")
		expect(schema.indexes).toContain("idx_email_unique")
	})
})

describe("extractDropStatements", () => {
	it("finds DROP TABLE statements (normalized without IF EXISTS)", () => {
		const drops = extractDropStatements("DROP TABLE old_table; DROP TABLE IF EXISTS another;")
		expect(drops).toContain("DROP TABLE old_table")
		expect(drops).toContain("DROP TABLE another")
	})

	it("returns empty for no drops", () => {
		expect(extractDropStatements("CREATE TABLE a (id TEXT);")).toHaveLength(0)
	})
})

describe("classifyMigration", () => {
	it("classifies safe migrations", () => {
		const result = classifyMigration("CREATE TABLE a (id TEXT PRIMARY KEY);")
		expect(result.safety).toBe("safe")
	})

	it("classifies cautious migrations (DROP with IF EXISTS)", () => {
		const result = classifyMigration("DROP TABLE IF EXISTS old;")
		expect(result.safety).toBe("cautious")
	})

	it("classifies unsafe migrations (DROP without IF EXISTS)", () => {
		const result = classifyMigration("DROP TABLE critical_data;")
		expect(result.safety).toBe("unsafe")
		expect(result.unsafeStatements.length).toBeGreaterThan(0)
	})
})

describe("makeIdempotent", () => {
	it("adds IF NOT EXISTS to CREATE INDEX", () => {
		const result = makeIdempotent(["CREATE INDEX idx_foo ON bar (baz)"])
		expect(result[0]).toContain("IF NOT EXISTS")
	})

	it("adds IF EXISTS to DROP INDEX", () => {
		const result = makeIdempotent(["DROP INDEX idx_foo"])
		expect(result[0]).toContain("IF EXISTS")
	})

	it("does not modify already idempotent statements", () => {
		const result = makeIdempotent(["CREATE INDEX IF NOT EXISTS idx_foo ON bar (baz)"])
		expect(result[0]).toBe("CREATE INDEX IF NOT EXISTS idx_foo ON bar (baz)")
	})
})

describe("splitSqlStatements — string literals", () => {
	it("does not split on a semicolon inside a string literal", () => {
		const stmts = splitSqlStatements("INSERT INTO t VALUES ('a;b'); SELECT 1;")
		expect(stmts).toHaveLength(2)
		expect(stmts[0]).toContain("'a;b'")
	})

	it("handles a doubled quote escape inside a literal", () => {
		const stmts = splitSqlStatements("INSERT INTO t VALUES ('o''brien;x'); SELECT 1;")
		expect(stmts).toHaveLength(2)
		expect(stmts[0]).toContain("o''brien;x")
	})

	it("handles double-quoted identifiers containing a semicolon", () => {
		const stmts = splitSqlStatements('CREATE TABLE "we;ird" (id TEXT); SELECT 1;')
		expect(stmts).toHaveLength(2)
	})
})

describe("extractSchema — table renames", () => {
	it("carries the columns across an ALTER TABLE ... RENAME TO", () => {
		const schema = extractSchema(`
			CREATE TABLE new_post (id TEXT, title TEXT);
			ALTER TABLE new_post RENAME TO post;
		`)
		expect(schema.tables.has("post")).toBe(true)
		expect(schema.tables.has("new_post")).toBe(false)
	})

	it("ignores a rename of a table it never saw created", () => {
		const schema = extractSchema("ALTER TABLE ghost RENAME TO spirit;")
		expect(schema.tables.has("spirit")).toBe(false)
	})
})

describe("extractDropStatements", () => {
	it("names a dropped table", () => {
		expect(extractDropStatements("DROP TABLE post;")).toEqual(["DROP TABLE post"])
		expect(extractDropStatements("DROP TABLE IF EXISTS post;")).toEqual(["DROP TABLE post"])
	})

	it("names a dropped column with its table", () => {
		expect(extractDropStatements("ALTER TABLE post DROP COLUMN title;")).toEqual(["DROP COLUMN post.title"])
	})

	it("names a dropped index", () => {
		expect(extractDropStatements("DROP INDEX idx_post_title;")).toEqual(["DROP INDEX idx_post_title"])
		expect(extractDropStatements("DROP INDEX IF EXISTS idx_post_title;")).toEqual(["DROP INDEX idx_post_title"])
	})

	it("collects every drop in one migration", () => {
		const drops = extractDropStatements(`
			DROP TABLE a;
			ALTER TABLE b DROP COLUMN c;
			DROP INDEX d;
		`)
		expect(drops).toHaveLength(3)
	})

	it("reports nothing for a migration that drops nothing", () => {
		expect(extractDropStatements("CREATE TABLE post (id TEXT);")).toEqual([])
	})
})

describe("classifyMigration", () => {
	it("calls a create-only migration safe", () => {
		expect(classifyMigration("CREATE TABLE post (id TEXT);").safety).toBe("safe")
	})

	it("calls an unguarded DROP TABLE unsafe", () => {
		const result = classifyMigration("DROP TABLE post;")
		expect(result.safety).toBe("unsafe")
		expect(result.unsafeStatements).toHaveLength(1)
	})

	it("calls a guarded DROP TABLE merely cautious", () => {
		expect(classifyMigration("DROP TABLE IF EXISTS post;").safety).toBe("cautious")
	})

	it("calls DROP COLUMN and TRUNCATE unsafe", () => {
		expect(classifyMigration("ALTER TABLE post DROP COLUMN title;").safety).toBe("unsafe")
		expect(classifyMigration("TRUNCATE post;").safety).toBe("unsafe")
	})

	it("flags adding NOT NULL with no default", () => {
		expect(classifyMigration("ALTER TABLE post ADD COLUMN x TEXT NOT NULL;").safety).toBe("unsafe")
		expect(classifyMigration("ALTER TABLE post ADD COLUMN x TEXT NOT NULL DEFAULT '';").safety).toBe("safe")
	})

	it("truncates a long statement in the report", () => {
		const long = `DROP TABLE ${"x".repeat(200)};`
		expect(classifyMigration(long).unsafeStatements[0]).toContain("...")
		expect(classifyMigration(long).unsafeStatements[0]!.length).toBeLessThan(90)
	})
})

describe("makeIdempotent", () => {
	it("guards CREATE INDEX, including the unique form", () => {
		expect(makeIdempotent(["CREATE INDEX i ON t (c)"])[0]).toBe("CREATE INDEX IF NOT EXISTS i ON t (c)")
		expect(makeIdempotent(["CREATE UNIQUE INDEX i ON t (c)"])[0]).toBe("CREATE UNIQUE INDEX IF NOT EXISTS i ON t (c)")
	})

	it("guards DROP INDEX", () => {
		expect(makeIdempotent(["DROP INDEX i"])[0]).toBe("DROP INDEX IF EXISTS i")
	})

	it("leaves an already-guarded statement untouched", () => {
		expect(makeIdempotent(["CREATE INDEX IF NOT EXISTS i ON t (c)"])[0]).toBe("CREATE INDEX IF NOT EXISTS i ON t (c)")
		expect(makeIdempotent(["DROP INDEX IF EXISTS i"])[0]).toBe("DROP INDEX IF EXISTS i")
	})

	it("leaves statements it does not guard exactly as they were", () => {
		const original = "CREATE TABLE post (id TEXT)"
		expect(makeIdempotent([original])[0]).toBe(original)
	})
})

describe("parseMigration", () => {
	it("assembles hash, schema, guarded statements, drops and classification", () => {
		const sql = "CREATE TABLE post (id TEXT);\nDROP TABLE old;\nCREATE INDEX i ON post (id);"
		const parsed = parseMigration(sql, "0001_init.sql")

		expect(parsed.filename).toBe("0001_init.sql")
		expect(parsed.sql).toBe(sql)
		expect(parsed.hash).toMatch(/^[\da-f]+$/)
		expect(parsed.drops).toContain("DROP TABLE old")
		expect(parsed.classification.safety).toBe("unsafe")
		expect(parsed.statements.some((s) => s.includes("IF NOT EXISTS"))).toBe(true)
		expect(parsed.expected.tables.has("post")).toBe(true)
	})

	it("hashes the same SQL to the same value and different SQL differently", () => {
		expect(parseMigration("SELECT 1;", "a.sql").hash).toBe(parseMigration("SELECT 1;", "b.sql").hash)
		expect(parseMigration("SELECT 1;", "a.sql").hash).not.toBe(parseMigration("SELECT 2;", "a.sql").hash)
	})
})
