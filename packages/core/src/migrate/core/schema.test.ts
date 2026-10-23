import { describe, expect, it } from "vitest"
import { historyFacts } from "./pg-history.ts"
import { extractSchema } from "./schema.ts"

/* Atlas v1.3.0's SQLite rebuild of a parent with a self-reference, and drizzle-kit's own export forms */
const HISTORY = `CREATE TABLE \`u\` (\`id\` integer PRIMARY KEY AUTOINCREMENT, \`boss\` integer REFERENCES \`u\`(\`id\`));
CREATE TABLE \`post\` (
\`id\` integer PRIMARY KEY AUTOINCREMENT,
\`author\` integer NOT NULL,
\`slug\` text GENERATED ALWAYS AS (lower(\`title\`)) VIRTUAL,
\`title\` text,
\`n\` integer AS (\`id\` + 1) STORED,
CONSTRAINT \`post_author_fk\` FOREIGN KEY (\`author\`) REFERENCES \`u\`(\`id\`) ON UPDATE no action ON DELETE cascade
);
CREATE TABLE "tag" ("post" integer, "name" text, PRIMARY KEY ("post", "name"), FOREIGN KEY ("post") REFERENCES "post" ON DELETE SET NULL) WITHOUT ROWID;
ALTER TABLE \`tag\` ADD COLUMN \`by\` integer REFERENCES \`u\`(\`id\`) ON DELETE RESTRICT;
CREATE TRIGGER IF NOT EXISTS \`post_ai\` AFTER INSERT ON \`post\` BEGIN SELECT 1; END;
CREATE TRIGGER "gone_t" AFTER INSERT ON "post" BEGIN SELECT 1; END;
DROP TRIGGER "gone_t";`

describe("extractSchema: foreign keys, triggers, functions and table shapes", () => {
	it("reads each foreign key, inline, table-level and added, with its ON DELETE action", () => {
		expect(extractSchema(HISTORY).foreignKeys).toEqual([
			{ columns: ["boss"], onDelete: "NO ACTION", parent: "u", parentColumns: ["id"], table: "u" },
			{ columns: ["author"], onDelete: "CASCADE", parent: "u", parentColumns: ["id"], table: "post" },
			{ columns: ["post"], onDelete: "SET NULL", parent: "post", parentColumns: [], table: "tag" },
			{ columns: ["by"], onDelete: "RESTRICT", parent: "u", parentColumns: ["id"], table: "tag" },
		])
	})

	it("reads each table's primary key, rowid, AUTOINCREMENT and generated columns, and the triggers left", () => {
		const schema = extractSchema(HISTORY)
		expect(Object.fromEntries(schema.tableInfo)).toEqual({
			post: {
				affinity: { author: "INTEGER", id: "INTEGER", n: "INTEGER", slug: "TEXT", title: "TEXT" },
				autoincrement: true,
				conflicts: [],
				generatedColumns: ["slug", "n"],
				primaryKey: ["id"],
				rowidAlias: true,
				strict: false,
				withoutRowid: false,
			},
			tag: {
				affinity: { by: "INTEGER", name: "TEXT", post: "INTEGER" },
				autoincrement: false,
				conflicts: [],
				generatedColumns: [],
				primaryKey: ["post", "name"],
				rowidAlias: false,
				strict: false,
				withoutRowid: true,
			},
			u: {
				affinity: { boss: "INTEGER", id: "INTEGER" },
				autoincrement: true,
				conflicts: [],
				generatedColumns: [],
				primaryKey: ["id"],
				rowidAlias: true,
				strict: false,
				withoutRowid: false,
			},
		})
		expect(schema.triggers).toEqual([{ events: ["insert"], ftsSync: false, name: "post_ai", table: "post" }])
	})
})

describe("extractSchema: what a rebuild, a drop and a rename do to keys and shapes", () => {
	it("follows Atlas's rebuild: the copy's keys replace the table's, its self-reference kept on the name", () => {
		const rebuilt = extractSchema(
			`CREATE TABLE \`new_u\` (\`id\` integer NOT NULL, \`boss\` integer NULL, PRIMARY KEY (\`id\`), CONSTRAINT \`0\` FOREIGN KEY (\`boss\`) REFERENCES \`u\` (\`id\`) ON UPDATE NO ACTION ON DELETE NO ACTION);
INSERT INTO \`new_u\` (\`id\`, \`boss\`) SELECT \`id\`, \`boss\` FROM \`u\`;
DROP TABLE \`u\`;
ALTER TABLE \`new_u\` RENAME TO \`u\`;`,
			extractSchema(HISTORY),
		)
		expect(rebuilt.foreignKeys.filter((fk) => fk.table === "u")).toEqual([
			{ columns: ["boss"], onDelete: "NO ACTION", parent: "u", parentColumns: ["id"], table: "u" },
		])
		expect(rebuilt.tableInfo.get("u")).toEqual({
			affinity: { boss: "INTEGER", id: "INTEGER" },
			autoincrement: false,
			conflicts: [],
			generatedColumns: [],
			primaryKey: ["id"],
			rowidAlias: true,
			strict: false,
			withoutRowid: false,
		})
		expect(rebuilt.tableInfo.has("new_u")).toBe(false)
	})
	it("drops a dropped table's keys, triggers and shape, and renames them with the table", () => {
		const after = extractSchema('DROP TABLE "tag";\nALTER TABLE "post" RENAME TO "article";', extractSchema(HISTORY))
		expect(after.foreignKeys.map((fk) => `${fk.table}->${fk.parent}`)).toEqual(["u->u", "article->u"])
		expect(after.triggers).toEqual([{ events: ["insert"], ftsSync: false, name: "post_ai", table: "article" }])
		expect([...after.tableInfo.keys()]).toEqual(["u", "article"])
	})

	it("reads an inline reference without columns as the parent's key, a bare column, and an added generated one", () => {
		const schema = extractSchema(
			"CREATE TABLE c (p integer REFERENCES p, bare, g integer);\nALTER TABLE c ADD COLUMN h integer AS (g + 1);\nALTER TABLE c ADD COLUMN plain text;\nALTER TABLE unseen ADD COLUMN x integer AS (1);",
		)
		expect(schema.foreignKeys).toEqual([
			{ columns: ["p"], onDelete: "NO ACTION", parent: "p", parentColumns: [], table: "c" },
		])
		expect(schema.tables.get("c")).toEqual(["p", "bare", "g", "h", "plain"])
		expect(schema.tableInfo.get("c")?.generatedColumns).toEqual(["h"])
		expect(schema.tableInfo.has("unseen")).toBe(false)
		expect(extractSchema("CREATE TABLE e ();").tableInfo.get("e")?.primaryKey).toEqual([])
	})

	it("reads the functions and procedures a Postgres file creates from its parse trees, and keeps a dropped one's name", () => {
		const schema = extractSchema(
			`CREATE OR REPLACE FUNCTION "public"."purge"() RETURNS void LANGUAGE plpgsql AS $$ BEGIN DELETE FROM a; END $$;
CREATE PROCEDURE p() LANGUAGE sql AS $$ SELECT 1; $$;
CREATE FUNCTION gone() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;
DROP FUNCTION IF EXISTS gone();`,
			undefined,
			"postgres",
		)
		expect([...historyFacts(schema).defined]).toEqual(["purge", "p", "gone"])
	})
})

/** Whether table t of `sql` is keyed by its rowid */
const alias = (sql: string) => extractSchema(sql).tableInfo.get("t")?.rowidAlias

describe("extractSchema: trigger events and FTS sync triggers", () => {
	it("forgets an external FTS5 table it drops", () => {
		const schema = extractSchema(
			"CREATE VIRTUAL TABLE post_fts USING fts5(title, content='post');\nDROP TABLE post_fts;",
		)
		expect(schema.externalFts).toEqual([])
	})

	it("records each trigger's events, joined by OR on Postgres, and whether it syncs an external FTS5 table", () => {
		const pg = extractSchema(
			"CREATE TRIGGER t BEFORE INSERT OR UPDATE OF a, b OR DELETE ON post FOR EACH ROW EXECUTE FUNCTION f();",
			undefined,
			"postgres",
		)
		/* a Postgres history's triggers are read from its parse trees, not its text */
		expect(pg.triggers).toEqual([])
		expect(historyFacts(pg).triggers).toEqual(
			new Map([["post", [{ events: ["insert", "delete", "update"], name: "t" }]]]),
		)
		const fts = extractSchema(
			"CREATE VIRTUAL TABLE post_fts USING fts5(title, content='post');\nCREATE TRIGGER post_fts_ad AFTER DELETE ON post BEGIN INSERT INTO post_fts(post_fts, rowid, title) VALUES ('delete', old.id, old.title); END;\nCREATE TRIGGER copy AFTER DELETE ON post BEGIN INSERT INTO post_fts(rowid, title) SELECT id, title FROM post; END;\nCREATE TRIGGER nobody AFTER DELETE ON post BEGIN SELECT 1; END;",
		)
		expect(extractSchema("CREATE TRIGGER cut AFTER DELETE ON post").triggers).toMatchObject([
			{ ftsSync: false, name: "cut" },
		])
		expect(fts.triggers.map(({ ftsSync, name }) => [name, ftsSync])).toEqual([
			["post_fts_ad", true],
			["copy", false],
			["nobody", false],
		])
	})
})

describe("extractSchema: rowid aliases", () => {
	it("reads a rowid alias: a lone INTEGER key, inline or table-level, but no DESC inline key, other type, composite or WITHOUT ROWID", () => {
		expect(alias("CREATE TABLE t (id integer PRIMARY KEY, x text);")).toBe(true)
		expect(alias("CREATE TABLE t (`id` INTEGER NOT NULL, `x` text, PRIMARY KEY (`id`));")).toBe(true)
		expect(alias("CREATE TABLE t (id integer, PRIMARY KEY (id DESC));")).toBe(true)
		expect(
			extractSchema("CREATE TABLE t (a text, b text, PRIMARY KEY (a COLLATE nocase ASC, `b` DESC));").tableInfo.get("t")
				?.primaryKey,
		).toEqual(["a", "b"])
		expect(alias("CREATE TABLE t (id integer PRIMARY KEY DESC);")).toBe(false)
		expect(alias("CREATE TABLE t (id int PRIMARY KEY);")).toBe(false)
		expect(alias("CREATE TABLE t (id integer unsigned PRIMARY KEY);")).toBe(false)
		expect(alias("CREATE TABLE t (id text PRIMARY KEY);")).toBe(false)
		expect(alias("CREATE TABLE t (id, PRIMARY KEY (id));")).toBe(false)
		expect(alias("CREATE TABLE t (a integer, b integer, PRIMARY KEY (a, b));")).toBe(false)
		expect(alias("CREATE TABLE t (id integer PRIMARY KEY) WITHOUT ROWID;")).toBe(false)
		expect(alias("CREATE TABLE t (x text);")).toBe(false)
		expect(alias("CREATE TABLE t (a integer, PRIMARY KEY (b));")).toBe(false)
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

describe("extractSchema: comments and strings around a statement", () => {
	it("reads a table's columns past a leading comment and a string that hold parentheses", () => {
		const schema = extractSchema(`-- Hand-written (see 20261003181500): additive only.
CREATE TABLE \`device\` (\`id\` text NOT NULL, \`label\` text DEFAULT '(none', \`user_id\` text NOT NULL, PRIMARY KEY (\`id\`));
/* (an index) */ CREATE INDEX \`idx_device_user\` ON \`device\` (\`user_id\`);
-- (drop) note
ALTER TABLE \`device\` ADD COLUMN \`os\` text;`)
		expect(schema.tables.get("device")).toEqual(["id", "label", "user_id", "os"])
		expect(schema.indexes).toEqual(["idx_device_user"])
	})
})

describe("extractSchema: no comment or string steers what a statement does", () => {
	const base = "CREATE TABLE `t` (`id` text PRIMARY KEY, `a` text);\nCREATE TABLE `x` (`id` text);\n"
	const after = (sql: string) => extractSchema(`${base}${sql}`)

	it("drops no table a comment or a string names", () => {
		const schema = after("-- was: DROP TABLE x\nUPDATE `t` SET `a` = 'DROP TABLE x';")
		expect([...schema.tables.keys()]).toEqual(["t", "x"])
		expect(schema.droppedTables).toEqual([])
	})

	it("renames no table a comment or a string names", () => {
		const schema = after("/* ALTER TABLE t RENAME TO y */ UPDATE `t` SET `a` = 'ALTER TABLE x RENAME TO z';")
		expect([...schema.tables.keys()]).toEqual(["t", "x"])
	})

	it("adds, drops and renames no column a comment or a string names", () => {
		const schema = after(`-- ALTER TABLE t ADD COLUMN ghost text
-- ALTER TABLE t DROP COLUMN a
/* ALTER TABLE t RENAME COLUMN a TO b */ UPDATE \`t\` SET \`a\` = 'ALTER TABLE t DROP COLUMN id';
/* a comment first */ ALTER TABLE \`t\` ADD COLUMN \`n\` text DEFAULT 'ALTER TABLE t DROP COLUMN a';`)
		expect(schema.tables.get("t")).toEqual(["id", "a", "n"])
	})

	it("creates no table or index a comment or a string names", () => {
		const schema = after(`-- CREATE TABLE ghost (g text)
/* CREATE INDEX ghost_idx ON t (a) */ UPDATE \`t\` SET \`a\` = 'CREATE TABLE y (z text)';`)
		expect([...schema.tables.keys()]).toEqual(["t", "x"])
		expect(schema.indexes).toEqual([])
	})

	it("still follows the statements themselves, quoted or schema-qualified", () => {
		const schema = after(`ALTER TABLE "t" ADD COLUMN "b" text;
ALTER TABLE main.t RENAME COLUMN a TO c;
CREATE INDEX "t_b" ON "t" ("b");
DROP TABLE \`x\`;
ALTER TABLE t RENAME TO u;`)
		expect(Object.fromEntries(schema.tables)).toEqual({ u: ["id", "c", "b"] })
		expect(schema.indexes).toEqual(["t_b"])
		expect(schema.droppedTables).toEqual(["x"])
	})
})

/* M37 of the 0.13 review: SQLite folds an identifier's ASCII letters only */
describe("extractSchema: names SQLite folds", () => {
	it('keeps "Über" and "über" apart, and "Users" and "users" one, tables and triggers alike', () => {
		const schema = extractSchema(
			'CREATE TABLE "Über" (a);\nCREATE TABLE "über" (b);\nCREATE TABLE "Users" (c);\nCREATE TRIGGER t AFTER INSERT ON "Über" BEGIN SELECT 1; END;',
		)
		expect([...schema.tables.keys()]).toEqual(["Über", "über", "users"])
		expect(schema.triggers.map(({ table }) => table)).toEqual(["Über"])
	})
})
