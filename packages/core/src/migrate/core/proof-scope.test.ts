import { describe, expect, it, vi } from "vitest"
import { verdictOf } from "../__fixtures__/copy-verdict.ts"
import { libsqlConnection } from "../__fixtures__/libsql-connection.ts"
import { scopeCorpus } from "../__fixtures__/scope-corpus.ts"
import { notEngineTables } from "./engine-tables.ts"
import { copyScript, creatable, jsonColumns, type LiveObject, liveObjects, scriptOf } from "./proof-copy.ts"
import { observable } from "./proof-scope.ts"

vi.mock("bun:sqlite", () => import("../__fixtures__/bun-sqlite-node.ts"))

/** The live objects a database `schema` made holds, as check reads them */
async function liveOf(schema: string): Promise<LiveObject[]> {
	const live = libsqlConnection()
	try {
		await live.client.executeMultiple(schema)
		return creatable(await liveObjects(live, notEngineTables(live)))
	} finally {
		await live.close()
	}
}

/** SQLite's answer to `sources` on the scoped copy and on the whole schema's copy */
async function verdicts(schema: string, sources: readonly string[]): Promise<{ scoped: string; whole: string }> {
	const objects = await liveOf(schema)
	const files = sources.map((sql) => ({ sql }))
	return {
		scoped: verdictOf(await copyScript(objects, files, "d1_migrations"), sources),
		whole: verdictOf(await scriptOf(objects, { json: jsonColumns(files), variant: 0 }), sources),
	}
}

/** A live table */
const table = (name: string, sql: string): LiveObject => ({ name, sql, table: name, type: "table" })

/** A live view */
const view = (name: string, sql: string): LiveObject => ({ name, sql, table: name, type: "view" })

/* 8.5 of plan 21, ruled 23:35Z: "the closure is enough" is a test, not an argument */
describe("the D1 proof's scoped copy answers every corpus file as the whole schema's copy does (8.5)", () => {
	const corpus = scopeCorpus()

	it.each(corpus.map((each) => [each.label, each] as const))("%s", async (_, { files, schema }) => {
		const { scoped, whole } = await verdicts(schema, files)
		expect(scoped).toBe(whole)
	})

	it("holds files the whole schema refuses, so an equal verdict is not one that passes everything", async () => {
		const refused = []
		for (const { files, schema } of corpus) if ((await verdicts(schema, files)).whole !== "passes") refused.push(files)
		expect(refused.length).toBeGreaterThanOrEqual(20)
	}, 60_000)
})

describe("observable: the key ancestors of what the scoped copy creates", () => {
	/* without either engine: a write to a created table compiles checks against each key's parent, so the copy must
	   hold them all, which the D1 leg's differential sees and the bun:sqlite leg's does not */
	it("creates the key ancestors of a table only a trigger brings in, transitively, and seeds none of them", () => {
		const objects = [
			table("org", "CREATE TABLE org (id INTEGER PRIMARY KEY)"),
			table("team", "CREATE TABLE team (id INTEGER PRIMARY KEY, org INTEGER NOT NULL REFERENCES org (id))"),
			table("member", "CREATE TABLE member (id INTEGER PRIMARY KEY, team INTEGER NOT NULL REFERENCES team (id))"),
			table("audit", "CREATE TABLE audit (id INTEGER PRIMARY KEY, what TEXT)"),
			{
				name: "log",
				sql: "CREATE TRIGGER log AFTER INSERT ON member BEGIN INSERT INTO audit (what) VALUES ('joined'); END",
				table: "member",
				type: "trigger",
			},
		]
		const scope = observable(objects, [{ sql: "ALTER TABLE audit RENAME COLUMN what TO what_2;" }])
		expect(scope.objects.map(({ name }) => name)).toEqual(["org", "team", "member", "audit", "log"])
		expect([...scope.seeded]).toEqual(["audit"])
	})

	it("creates and seeds the table an FTS table reads its rows from, however its content option names it", () => {
		const objects = [
			table("post", "CREATE TABLE post (id INTEGER PRIMARY KEY, body TEXT)"),
			table("It's", 'CREATE TABLE "It\'s" (id INTEGER PRIMARY KEY, body TEXT)'),
			table("a", "CREATE VIRTUAL TABLE a USING fts5(body, content=post)"),
			table("b", "CREATE VIRTUAL TABLE b USING fts5(body, content='It''s', content_rowid='id')"),
			table("cl", "CREATE VIRTUAL TABLE cl USING fts5(body, content='')"),
		]
		const scope = observable(objects, [{ sql: "SELECT * FROM a, b, cl;" }], "h")
		expect(scope.objects.map(({ name }) => name)).toEqual(["post", "It's", "a", "b", "cl"])
		expect([...scope.seeded].toSorted()).toEqual(["a", "b", "cl", "it's", "post"])
		expect(observable(objects, [{ sql: "SELECT * FROM cl;" }], "h").objects.map(({ name }) => name)).toEqual(["cl"])
	})
})

describe("observable: what the scoped copy creates and seeds", () => {
	it("reads a shadow table's name as its virtual table's, and a key to a table the schema lacks as none", () => {
		const objects = [
			table("docs", "CREATE VIRTUAL TABLE docs USING fts5 (body)"),
			table("box", "CREATE VIRTUAL TABLE box USING no_such_module (x)"),
			table("orphan", "CREATE TABLE orphan (id INTEGER PRIMARY KEY, p INTEGER REFERENCES gone (id))"),
		]
		const scope = observable(objects, [{ sql: "DELETE FROM docs_data; UPDATE orphan SET p = NULL;" }], "h")
		expect(scope.objects.map(({ name }) => name)).toEqual(["docs", "orphan"])
		expect([...scope.seeded].toSorted()).toEqual(["docs", "orphan"])
	})

	it("seeds what a file writes, its descendants and every ancestor of both, and no ancestor's other child", () => {
		const objects = [
			table("Org", "CREATE TABLE Org (id INTEGER PRIMARY KEY, gone INTEGER REFERENCES elsewhere (id))"),
			table("team", 'CREATE TABLE team (id INTEGER PRIMARY KEY, org INTEGER REFERENCES "ORG" (id))'),
			table("member", "CREATE TABLE member (id INTEGER PRIMARY KEY, team INTEGER REFERENCES team (id))"),
			table("sibling", "CREATE TABLE sibling (id INTEGER PRIMARY KEY, org INTEGER REFERENCES org (id))"),
		]
		const scope = observable(objects, [{ sql: "UPDATE team SET id = id;" }], "h")
		expect([...scope.seeded].toSorted()).toEqual(["member", "org", "team"])
		expect(scope.objects.map(({ name }) => name)).toEqual(["Org", "team", "member"])
	})

	it("seeds the history table a pending file never names, and no table it does not name", () => {
		const objects = [
			table("d1_migrations", "CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT)"),
			table("other", "CREATE TABLE other (x)"),
		]
		expect([...observable(objects, [{ sql: "SELECT 1;" }], "D1_Migrations").seeded]).toEqual(["d1_migrations"])
	})
})

/* AC2-4 of area C round 2: SQLite's ALTER check resolves each view and trigger against what it names, and needs no
   key ancestor or index of a table only those name */
describe("observable: with an ALTER TABLE pending", () => {
	const objects = [
		table("t", "CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT)"),
		table("p0", "CREATE TABLE p0 (id INTEGER PRIMARY KEY)"),
		table("p1", "CREATE TABLE p1 (id INTEGER PRIMARY KEY, up INTEGER REFERENCES p0 (id))"),
		table("p2", "CREATE TABLE p2 (id INTEGER PRIMARY KEY, up INTEGER REFERENCES p1 (id))"),
		{ name: "p2_up", sql: "CREATE INDEX p2_up ON p2 (up)", table: "p2", type: "index" },
		view("v1", "CREATE VIEW v1 AS SELECT id FROM p2"),
		view("v2", "CREATE VIEW v2 AS SELECT id FROM v1"),
		table("q", "CREATE TABLE q (id INTEGER PRIMARY KEY, up INTEGER REFERENCES p0 (id))"),
		table("r", "CREATE TABLE r (id INTEGER PRIMARY KEY)"),
		{
			name: "q_in",
			sql: "CREATE TRIGGER q_in AFTER INSERT ON q BEGIN INSERT INTO r DEFAULT VALUES; END",
			table: "q",
			type: "trigger",
		},
	]

	it("creates every view and trigger and what each names, through views, and no ancestor or index only they reach", () => {
		const scope = observable(objects, [{ sql: "ALTER TABLE t RENAME COLUMN a TO b;" }])
		expect(scope.objects.map(({ name }) => name)).toEqual(["t", "p2", "v1", "v2", "q", "r", "q_in"])
		expect([...scope.seeded]).toEqual(["t"])
	})
})

/* AC2-1 of area C round 2, and ruling 3 of area C round 3: what reads the schema itself observes every object and
   SQLite's own tables, which the rows of every table make */
/* a table, one SQLite counts the ids of, a view of it, and a view that reflects */
const REFLECTING = [
	table("t", "CREATE TABLE t (id INTEGER PRIMARY KEY, n TEXT)"),
	table("far", "CREATE TABLE far (id INTEGER PRIMARY KEY AUTOINCREMENT)"),
	view("far_v", "CREATE VIEW far_v AS SELECT id FROM far"),
	view("cat_v", "CREATE VIEW cat_v AS SELECT name FROM sqlite_schema"),
]

describe("observable: a file or a created object that reflects on the schema", () => {
	const objects = REFLECTING
	const names = (sql: string) => observable(objects, [{ sql }]).objects.map(({ name }) => name)

	it.each([
		"INSERT INTO t (n) SELECT name FROM sqlite_master;",
		"INSERT INTO t (n) SELECT name FROM main.SQLITE_SCHEMA;",
		"INSERT INTO t (n) SELECT name FROM sqlite_temp_master;",
		'INSERT INTO t (n) SELECT name FROM "sqlite_temp_schema";',
		"INSERT INTO t (n) SELECT name FROM pragma_table_list;",
		"INSERT INTO t (n) SELECT name FROM pragma_table_info('t');",
		"INSERT INTO t (n) SELECT count(*) FROM sqlite_sequence;",
		"ANALYZE;\nINSERT INTO t (n) SELECT stat FROM [sqlite_stat1];",
		"UPDATE t SET n = 'x';\nPRAGMA table_list;",
		"UPDATE t SET n = 'x';\nPRAGMA main.table_list;",
		"UPDATE t SET n = 'x';\nPRAGMA table_info('t');",
		"UPDATE t SET n = 'x';\nPRAGMA index_list(t);",
		"UPDATE t SET n = 'x';\nPRAGMA main.foreign_key_list(\"t\");",
		"PRAGMA foreign_keys = OFF;\nUPDATE t SET n = 'x';\nPRAGMA foreign_key_check;",
		"PRAGMA no_such_pragma = 1;\nUPDATE t SET n = 'x';",
		"PRAGMA foreign_keys(OFF;\nUPDATE t SET n = 'x';",
		"INSERT INTO t (n) SELECT name FROM cat_v;",
	])("creates every object for %j, and seeds every table", (sql) => {
		const scope = observable(objects, [{ sql }])
		expect(scope.objects.map(({ name }) => name)).toEqual(["t", "far", "far_v", "cat_v"])
		expect([...scope.seeded]).toEqual(["t", "far"])
	})

	it("reads a virtual table with no module arguments as one referencing only its own name", () => {
		const stat = table("s", "CREATE VIRTUAL TABLE s USING dbstat")
		expect(observable([...objects, stat], [{ sql: "SELECT * FROM s;" }]).objects).toEqual([stat])
	})

	it("reads a catalog's name in a comment as no read, and table_list outside a PRAGMA as a name", () => {
		expect(names("-- sqlite_master\nUPDATE t SET n = 'x';\n/* PRAGMA */ SELECT 1;")).toEqual(["t"])
		expect(names("UPDATE t SET n = 'table_list';")).toEqual(["t"])
	})
})

/* rulings 14:55Z of area C round 3: a pragma that only sets how statements run is no reflection */
describe("observable: a file with a pragma that touches no schema object", () => {
	const objects = REFLECTING

	it.each([
		"PRAGMA foreign_keys = OFF;",
		"PRAGMA foreign_keys;",
		"PRAGMA main.defer_foreign_keys = ON;",
		"PRAGMA temp.[defer_foreign_keys] = 'on';",
		'PRAGMA "legacy_alter_table" = 1;',
		"PRAGMA recursive_triggers(1);",
		"PRAGMA Case_Sensitive_Like = true;",
		"PRAGMA ignore_check_constraints = 0;",
		"PRAGMA busy_timeout = 5000;",
	])("creates and seeds only what the file names past %j", (pragma) => {
		const scope = observable(objects, [{ sql: `${pragma}\nUPDATE t SET n = 'x';` }])
		expect(scope.objects.map(({ name }) => name)).toEqual(["t"])
		expect([...scope.seeded]).toEqual(["t"])
	})

	it("scopes a drizzle-kit table rebuild to the rebuilt table and what reaches it", () => {
		const rebuild = [
			"PRAGMA foreign_keys=OFF;--> statement-breakpoint",
			"CREATE TABLE `__new_far` (`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL);--> statement-breakpoint",
			"INSERT INTO `__new_far`(`id`) SELECT `id` FROM `far`;--> statement-breakpoint",
			"DROP TABLE `far`;--> statement-breakpoint",
			"ALTER TABLE `__new_far` RENAME TO `far`;--> statement-breakpoint",
			"PRAGMA foreign_keys=ON;",
		].join("\n")
		/* cat_v reflects, and an ALTER pending creates every view */
		const scope = observable(
			objects.filter(({ name }) => name !== "cat_v"),
			[{ sql: rebuild }],
		)
		expect(scope.objects.map(({ name }) => name)).toEqual(["far", "far_v"])
		expect([...scope.seeded]).toEqual(["far"])
	})
})
