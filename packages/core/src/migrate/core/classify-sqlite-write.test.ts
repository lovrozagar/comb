import { describe, expect, it } from "vitest"
import { classifyMigration } from "./classify.ts"
import { extractSchema } from "./schema.ts"

/* the history: a table a, and a table logged whose insert trigger writes a */
const BEFORE = extractSchema(
	"CREATE TABLE a (id INTEGER PRIMARY KEY, x TEXT);\nCREATE TABLE logged (id INTEGER PRIMARY KEY);\nCREATE TRIGGER log_ai AFTER INSERT ON logged BEGIN DELETE FROM a; END;",
)
const lite = (sql: string) => classifyMigration(sql, { before: BEFORE, dialect: "sqlite" })

/*
 * T10 of the 2.3 review: on SQLite the proof run reads what a write does (proof-engine.ts). The
 * classifier alone, as a library caller runs it, marks every write it cannot clear unsafe, pending
 * that read; planApply's proof replaces those entries with the engine's findings.
 */
describe("classifyMigration on a SQLite write, without the proof run", () => {
	it.each([
		"DELETE FROM a;",
		"DELETE FROM a WHERE id = 1;",
		"UPDATE a SET x = 'y';",
		`UPDATE "a"SET x = 'y';`,
		"UPDATE OR REPLACE a SET x = 'y';",
		"REPLACE INTO a (id, x) VALUES (1, 'y');",
		"INSERT OR REPLACE INTO a (id, x) VALUES (1, 'y');",
		"INSERT INTO a (id, x) VALUES (1, 'y') ON CONFLICT (id) DO UPDATE SET x = excluded.x;",
		"WITH c AS (SELECT 1) DELETE FROM a;",
		"INSERT INTO logged (id) VALUES (1);",
	])("rates %j unsafe, pending the engine's read", (sql) => {
		const rated = lite(sql)
		expect(rated.safety).toBe("unsafe")
		expect(rated.pendingStatements).toEqual(rated.unsafeStatements)
		expect(rated.unsafeStatements.join("\n")).toContain("pending the proof run's read of what it writes")
	})

	it.each([
		["an insert into a table no trigger watches", "INSERT INTO a (id, x) VALUES (1, 'y');", "safe"],
		["an insert that does nothing on a conflict", "INSERT INTO a (id) VALUES (1) ON CONFLICT DO NOTHING;", "safe"],
		[
			"any write to a table the file created",
			"CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);\nUPDATE t SET v = 'y';\nDELETE FROM t;",
			"safe",
		],
		[
			"a backfill of a column the file added",
			"ALTER TABLE a ADD COLUMN plan TEXT;\nUPDATE a SET plan = 'free';",
			"cautious",
		],
	])("clears %s on its own", (_label, sql, safety) => {
		const rated = lite(sql)
		expect(rated.safety).toBe(safety)
		expect(rated.pendingStatements).toEqual([])
	})

	it("holds a second write to a column the file added for the engine", () => {
		expect(
			lite("ALTER TABLE a ADD COLUMN plan TEXT;\nUPDATE a SET plan = 'free';\nUPDATE a SET plan = 'pro';").safety,
		).toBe("unsafe")
	})
})

/* every assignment of a SET list is read, or the write is held: a backfill clears only when each is a new column */
describe("classifyMigration on a SQLite SET list beside a backfill", () => {
	it.each([
		`ALTER TABLE q ADD COLUMN plan TEXT;\nUPDATE q SET plan = 'free', "from" = 'y';`,
		"ALTER TABLE q ADD COLUMN plan TEXT;\nUPDATE q SET plan = 'free', [where] = 'y';",
		"ALTER TABLE q ADD COLUMN plan TEXT;\nUPDATE q SET plan = 'free', `returning` = 'y';",
	])("holds %j, an old column named for a keyword beside a backfill, for the engine", (sql) => {
		const before = extractSchema(
			'CREATE TABLE q (id INTEGER PRIMARY KEY, "from" TEXT, "where" TEXT, "returning" TEXT);',
		)
		expect(classifyMigration(sql, { before, dialect: "sqlite" }).safety).toBe("unsafe")
	})

	it("reads a parenthesized SET list: new columns only backfill, an old one among them is held", () => {
		const added = "ALTER TABLE a ADD COLUMN plan TEXT;\nALTER TABLE a ADD COLUMN tier TEXT;\n"
		expect(lite(`${added}UPDATE a SET (plan, tier) = ('free', 'low');`).safety).toBe("cautious")
		expect(lite(`${added}UPDATE a SET (plan, x) = ('free', 'y');`).safety).toBe("unsafe")
	})

	it("holds a SET list beside a backfill that it cannot read for the engine", () => {
		expect(lite("ALTER TABLE a ADD COLUMN plan TEXT;\nUPDATE a SET plan = 'free', 1 = 2;").safety).toBe("unsafe")
	})
})

/* T12 of the 2.3 re-probe: ON CONFLICT REPLACE in a table's definition makes a plain insert delete the row it meets */
describe("classifyMigration on a SQLite insert into a table that replaces on conflict", () => {
	const REPLACING = extractSchema(
		"CREATE TABLE a (id INTEGER PRIMARY KEY ON CONFLICT REPLACE, x TEXT);\nCREATE TABLE b (id INTEGER PRIMARY KEY, v TEXT UNIQUE ON CONFLICT REPLACE);\nCREATE TABLE c (id INTEGER PRIMARY KEY, v TEXT, UNIQUE (v) ON CONFLICT REPLACE);",
	)
	it.each([
		"INSERT INTO a VALUES (1, 'x');",
		"INSERT INTO b (v) VALUES ('x');",
		"INSERT INTO c (v) VALUES ('x');",
		"CREATE TABLE d (id INTEGER PRIMARY KEY ON CONFLICT REPLACE);\nINSERT INTO d VALUES (1);",
	])("holds %j for the engine", (sql) => {
		const rated = classifyMigration(sql, { before: REPLACING, dialect: "sqlite" })
		expect(rated.safety).toBe("unsafe")
		expect(rated.pendingStatements).toHaveLength(1)
	})
})
