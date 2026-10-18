import { describe, expect, it } from "vitest"
import {
	classifyMigration,
	extractDropStatements,
	extractSchema,
	generateMigrationHash,
	makeIdempotent,
	parseMigration,
	splitSqlStatements,
	legacyMigrationHash,
	migrationHashes,
} from "./parse.ts"

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
	it("continues from an earlier schema without changing it", () => {
		const first = extractSchema("CREATE TABLE post (id TEXT); CREATE INDEX i ON post (id); DROP TABLE gone;")
		const next = extractSchema("ALTER TABLE post ADD COLUMN title TEXT;", first)
		expect(next.tables.get("post")).toEqual(["id", "title"])
		expect(next.indexes).toEqual(["i"])
		expect(next.droppedTables).toEqual(["gone"])
		expect(first.tables.get("post")).toEqual(["id"])
	})

	it("follows ALTER TABLE ADD, DROP and RENAME COLUMN on a known table", () => {
		const schema = extractSchema(`
CREATE TABLE post (id TEXT PRIMARY KEY, title TEXT, body TEXT);
ALTER TABLE post ADD COLUMN locale TEXT;
ALTER TABLE \`post\` DROP COLUMN \`body\`;
ALTER TABLE post RENAME COLUMN title TO heading;
ALTER TABLE post DROP CONSTRAINT post_check;
ALTER TABLE post RENAME TO post;
ALTER TABLE gone ADD COLUMN x TEXT;
`)
		expect(schema.tables.get("post")).toEqual(["id", "heading", "locale"])
		expect(schema.tables.has("gone")).toBe(false)
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

	it("classifies cautious migrations: a drop that loses no rows", () => {
		expect(classifyMigration("DROP INDEX IF EXISTS idx_old;").safety).toBe("cautious")
		expect(classifyMigration("DROP TRIGGER t_ai;").safety).toBe("cautious")
	})

	it("classifies unsafe migrations (DROP without IF EXISTS)", () => {
		const result = classifyMigration("DROP TABLE critical_data;")
		expect(result.safety).toBe("unsafe")
		expect(result.unsafeStatements.length).toBeGreaterThan(0)
	})
	it.each(["ALTER TABLE `post` DROP COLUMN `title`;", 'ALTER TABLE "post" DROP COLUMN "title";', 'DROP TABLE "post";'])(
		"sees a drop through quoted identifiers: %s",
		(sql) => {
			expect(classifyMigration(sql).safety).toBe("unsafe")
		},
	)
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

	it("calls a guarded DROP TABLE unsafe: IF EXISTS guards the statement, not the rows", () => {
		expect(classifyMigration("DROP TABLE IF EXISTS post;").safety).toBe("unsafe")
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

describe("splitSqlStatements — what a statement is (S-12, S-13)", () => {
	it("keeps a trigger whole, its body's statements and a CASE … END included", () => {
		const sql = `CREATE TABLE t (a TEXT);
CREATE TRIGGER t_ai AFTER INSERT ON t BEGIN
	INSERT INTO log(v) VALUES (CASE WHEN new.a IS NULL THEN 'none' ELSE new.a END);
	DELETE FROM log WHERE v = 'x;y';
END;
CREATE INDEX i ON t(a);`
		expect(splitSqlStatements(sql).map((statement) => statement.split(/\s+/).slice(0, 2).join(" "))).toEqual([
			"CREATE TABLE",
			"CREATE TRIGGER",
			"CREATE INDEX",
		])
	})

	it("does not split on a ; inside a backtick, bracket or double-quoted name", () => {
		expect(splitSqlStatements('CREATE TABLE `a;b` (x);CREATE TABLE [c;d] (y);CREATE TABLE "e;f" (z)')).toHaveLength(3)
	})

	it("ends a statement whose last line is a comment holding a ;", () => {
		expect(splitSqlStatements("SELECT 1; -- note; more\nSELECT 2")).toEqual(["SELECT 1", "-- note; more\nSELECT 2"])
	})
})

describe("generateMigrationHash — normalization (S-13)", () => {
	it("keeps -- and /* */ inside a string literal: they are data, not comments", () => {
		expect(generateMigrationHash("INSERT INTO t VALUES ('a -- b')")).not.toBe(
			generateMigrationHash("INSERT INTO t VALUES ('a ')"),
		)
		expect(generateMigrationHash("INSERT INTO t VALUES ('/* x */')")).not.toBe(
			generateMigrationHash("INSERT INTO t VALUES ('')"),
		)
	})

	it("ignores comments, a final comment with no newline included, and whitespace outside literals", () => {
		const plain = generateMigrationHash("CREATE TABLE t (a TEXT);")
		expect(generateMigrationHash("-- head\nCREATE   TABLE t\n(a TEXT); -- tail")).toBe(plain)
		expect(generateMigrationHash("CREATE TABLE t /* inline */ (a TEXT);\n")).toBe(plain)
	})

	it("keeps whitespace inside a literal", () => {
		expect(generateMigrationHash("SELECT 'a  b'")).not.toBe(generateMigrationHash("SELECT 'a b'"))
	})
})

describe("extractSchema — a body that never closes", () => {
	it("reads columns past parentheses nested in defaults and checks, leaving constraints out", () => {
		const sql =
			"CREATE TABLE t (a INTEGER DEFAULT (unixepoch() * 1000), b TEXT, CHECK (b IN ('x', 'y')), PRIMARY KEY (a))"
		expect(extractSchema(sql).tables.get("t")).toEqual(["a", "b"])
	})

	it("still reads the columns it declares", () => {
		expect(extractSchema("CREATE TABLE t (a TEXT, b INTEGER").tables.get("t")).toEqual(["a", "b"])
	})
})

describe("classifyMigration and extractDropStatements — read the code, not the data (A-H4)", () => {
	it("is not fooled by DROP TABLE or IF EXISTS inside a string literal", () => {
		expect(classifyMigration("INSERT INTO log (msg) VALUES ('DROP TABLE users')").safety).toBe("safe")
		expect(extractDropStatements("INSERT INTO log (msg) VALUES ('DROP TABLE users')")).toEqual([])
		expect(classifyMigration("DROP TABLE users; INSERT INTO log VALUES ('IF EXISTS')").safety).toBe("unsafe")
	})

	it("treats DROP TABLE IF EXISTS as the data loss it is", () => {
		expect(classifyMigration("DROP TABLE IF EXISTS users").safety).toBe("unsafe")
		expect(extractDropStatements("DROP TABLE IF EXISTS users")).toEqual(["DROP TABLE users"])
	})

	it("sees SQLite's short ALTER TABLE … DROP form as a dropped column", () => {
		expect(extractDropStatements("ALTER TABLE t DROP c")).toEqual(["DROP COLUMN t.c"])
		expect(classifyMigration("ALTER TABLE t DROP c").safety).toBe("unsafe")
	})
})

describe("migrationHashes — the hashes a file may be recorded under", () => {
	it("is the current hash alone when the pre-0.5.0 one agrees, and both when they differ", () => {
		expect(migrationHashes("CREATE TABLE t (a TEXT);")).toEqual([generateMigrationHash("CREATE TABLE t (a TEXT);")])
		/* the legacy regex cuts from -- to the newline, inside the literal too */
		const sql = "INSERT INTO t VALUES ('a -- b\nc')"
		expect(legacyMigrationHash(sql)).not.toBe(generateMigrationHash(sql))
		expect(migrationHashes(sql)).toEqual([generateMigrationHash(sql), legacyMigrationHash(sql)])
	})

	it("keeps the legacy normalization, whose regexes cut -- inside literals", () => {
		expect(legacyMigrationHash("SELECT 'a -- b'\nSELECT 1")).toBe(legacyMigrationHash("SELECT 'a \nSELECT 1"))
	})
})
