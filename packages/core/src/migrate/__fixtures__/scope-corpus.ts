/**
 * The pending files the D1 proof's scoped copy must answer as the whole schema's copy does (8.5 of plan 21): the
 * SQLite and D1 proof suites' files over their live schemas, the trigger corpus (SL2), and generated shapes, each
 * statement kind over each object of a schema holding keys, cascades, triggers, views, indexes and a virtual table.
 * A finding on the D1 proof adds its file here.
 */
import { CORPUS, CORPUS_SETUP, corpusFile } from "./trigger-corpus.ts"

/** One case: what it shows, the live schema, and the pending file */
export type ScopeCase = { file: string; label: string; schema: string }

const D1_LIVE =
	"CREATE TABLE t (id INTEGER PRIMARY KEY, v REAL NOT NULL DEFAULT 1);\nINSERT INTO t (v) VALUES (2), (3);"

const CHILD_FIRST =
	"CREATE TABLE child (id INTEGER PRIMARY KEY, p INTEGER NOT NULL REFERENCES parent (id));\nCREATE TABLE parent (id INTEGER PRIMARY KEY);"
const CYCLE =
	"CREATE TABLE a (id INTEGER PRIMARY KEY, b INTEGER NOT NULL REFERENCES b (id));\nCREATE TABLE b (id INTEGER PRIMARY KEY, a INTEGER NOT NULL REFERENCES a (id));"

/* the D1 proof's own cases (d1-engine.test.ts) */
function d1Cases(): ScopeCase[] {
	return [
		["an rtree", D1_LIVE, "CREATE VIRTUAL TABLE box USING rtree (id, x0, x1);"],
		["an index and optimize", D1_LIVE, "CREATE INDEX t_v ON t (v);\nPRAGMA optimize(65538);"],
		["a trigger", D1_LIVE, "CREATE TRIGGER t_up AFTER UPDATE OF v ON t BEGIN SELECT abs(new.v); END;"],
		["a function in an UPDATE", D1_LIVE, "ALTER TABLE t ADD COLUMN sq REAL;\nUPDATE t SET sq = power(v, 2);"],
		[
			"a generated column",
			D1_LIVE,
			"CREATE TABLE g (id INTEGER PRIMARY KEY, v REAL, up REAL GENERATED ALWAYS AS (ceiling(v)) VIRTUAL);",
		],
		[
			"a trigger body run later",
			D1_LIVE,
			"CREATE TABLE sq (id INTEGER PRIMARY KEY, v REAL);\nCREATE TRIGGER t_sq AFTER INSERT ON t BEGIN INSERT INTO sq (id, v) VALUES (new.id, power(new.v, 2)); END;",
		],
		["a view run later", D1_LIVE, "CREATE VIEW stats AS SELECT max(v) AS top FROM t;"],
		["a child made first", CHILD_FIRST, "CREATE TABLE probe (id INTEGER PRIMARY KEY);"],
		["a DROP of a referenced parent", CHILD_FIRST, "DROP TABLE parent;"],
		["a DROP in a cycle", CYCLE, "DROP TABLE a;"],
		[
			"a self-reference",
			"CREATE TABLE node (id TEXT PRIMARY KEY, up TEXT REFERENCES node (id), n INTEGER) WITHOUT ROWID;",
			"UPDATE node SET n = 1;",
		],
	].map(([label, schema, file]) => ({
		file: file as string,
		label: `d1: ${label as string}`,
		schema: schema as string,
	}))
}

/* the trigger corpus, each file over its tables */
function triggerCases(): ScopeCase[] {
	return CORPUS.map(({ label, statements }) => ({
		file: corpusFile(statements),
		label: `trigger: ${label}`,
		schema: CORPUS_SETUP,
	}))
}

/** The schema the generated shapes run over */
export const SHAPES_SCHEMA = `CREATE TABLE org (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE team (id INTEGER PRIMARY KEY, org INTEGER NOT NULL REFERENCES org (id) ON DELETE CASCADE, name TEXT);
CREATE TABLE member (id INTEGER PRIMARY KEY, team INTEGER NOT NULL REFERENCES team (id) ON DELETE CASCADE, email TEXT NOT NULL);
CREATE TABLE invoice (id INTEGER PRIMARY KEY, org INTEGER NOT NULL REFERENCES org (id), total REAL CHECK (total >= 0));
CREATE TABLE audit (id INTEGER PRIMARY KEY, what TEXT NOT NULL, n INTEGER CHECK (n > 0));
CREATE TABLE note (id INTEGER PRIMARY KEY, body TEXT);
CREATE TABLE "Odd Name" (id INTEGER PRIMARY KEY, v TEXT);
CREATE INDEX member_email ON member (email);
CREATE UNIQUE INDEX invoice_org ON invoice (org, id);
CREATE TRIGGER member_gone AFTER DELETE ON member BEGIN INSERT INTO audit (what, n) VALUES ('member', -1); END;
CREATE TRIGGER note_touch AFTER UPDATE ON note BEGIN INSERT INTO audit (what, n) VALUES ('note', 1); END;
CREATE VIEW roster AS SELECT m.email, t.name FROM member m JOIN team t ON t.id = m.team;
CREATE VIEW billing AS SELECT o.name, i.total FROM invoice i JOIN org o ON o.id = i.org;
CREATE VIEW odd AS SELECT v FROM [odd name];
CREATE VIRTUAL TABLE note_fts USING fts5 (body);
`

const COLUMNS: Readonly<Record<string, readonly string[]>> = {
	'"Odd Name"': ["v"],
	audit: ["what", "n"],
	invoice: ["org", "total"],
	member: ["team", "email"],
	note: ["body"],
	org: ["name"],
	team: ["org", "name"],
}

/* each statement kind over each object of SHAPES_SCHEMA */
function shapes(): string[] {
	return [
		...Object.entries(COLUMNS).flatMap(([table, columns]) => [
			`DELETE FROM ${table};`,
			`UPDATE ${table} SET id = id;`,
			`INSERT INTO ${table} DEFAULT VALUES;`,
			`DROP TABLE ${table};`,
			`ALTER TABLE ${table} RENAME TO renamed;`,
			`ALTER TABLE ${table} ADD COLUMN extra TEXT;`,
			`CREATE TABLE ${table.toUpperCase()} (x);`,
			...columns.flatMap((column) => [
				`ALTER TABLE ${table} DROP COLUMN ${column};`,
				`ALTER TABLE ${table} RENAME COLUMN ${column} TO ${column}_2;`,
			]),
		]),
		...["roster", "billing", "odd"].flatMap((view) => [
			`DROP VIEW ${view};`,
			`CREATE TABLE snap AS SELECT * FROM ${view};`,
			`CREATE TABLE ${view} (x);`,
		]),
		...["member_email", "invoice_org"].flatMap((index) => [
			`DROP INDEX ${index};`,
			`CREATE INDEX ${index} ON note (body);`,
		]),
		...["member_gone", "note_touch"].flatMap((trigger) => [
			`DROP TRIGGER ${trigger};`,
			`CREATE TRIGGER ${trigger} AFTER INSERT ON note BEGIN SELECT 1; END;`,
		]),
		"INSERT INTO note_fts (body) VALUES ('x');",
		"INSERT INTO note_fts_data (id, block) VALUES (99, x'00');",
		"CREATE TABLE note_fts_config (x);",
		"DELETE FROM org WHERE id IN (SELECT org FROM team);",
		"UPDATE note SET body = 'changed';",
		"CREATE TABLE late (id INTEGER PRIMARY KEY, o INTEGER REFERENCES org (id));\nINSERT INTO late (o) SELECT id FROM org;",
	]
}

const EXTERNAL =
	"CREATE TABLE post (id INTEGER PRIMARY KEY, body TEXT);\nCREATE VIRTUAL TABLE ext USING fts5(body, content='post', content_rowid='id');"
const SRC = "CREATE TABLE src (id INTEGER PRIMARY KEY, body TEXT);"

/* an FTS table that reads another for its rows, and a table a file names only as a string, as SQLite reads one */
function ftsCases(): ScopeCase[] {
	return [
		["an external-content rebuild", EXTERNAL, "INSERT INTO ext(ext) VALUES ('rebuild');"],
		["an external-content delete-all", EXTERNAL, "INSERT INTO ext(ext) VALUES ('delete-all');"],
		["a read of an external-content table", EXTERNAL, "CREATE TABLE hits AS SELECT rowid, body FROM ext;"],
		[
			"an FTS table made over a table named in its content option",
			SRC,
			"CREATE VIRTUAL TABLE notes USING fts5(body, content='src', content_rowid='id');\nINSERT INTO notes(notes) VALUES ('rebuild');",
		],
		["a table named as a string", SRC, "CREATE TABLE cp AS SELECT * FROM 'src';"],
	].map(([label, schema, file]) => ({
		file: file as string,
		label: `fts: ${label as string}`,
		schema: schema as string,
	}))
}

const VIEW_OVER_BASE =
	"CREATE TABLE base (id INTEGER PRIMARY KEY, a TEXT);\nINSERT INTO base (a) VALUES ('x'), ('y');\nCREATE VIEW v AS SELECT id, a FROM base;"

/* a write through a view, which its INSTEAD OF trigger carries out on the tables the trigger names */
function viewTriggerCases(): ScopeCase[] {
	return [
		[
			"an INSTEAD OF trigger that inserts",
			`${VIEW_OVER_BASE}\nCREATE TRIGGER v_ins INSTEAD OF INSERT ON v BEGIN INSERT INTO base (a) VALUES (new.a); END;`,
			"INSERT INTO v (a) VALUES ('z');",
		],
		[
			"an INSTEAD OF trigger that deletes",
			`${VIEW_OVER_BASE}\nCREATE TRIGGER v_ins INSTEAD OF INSERT ON v BEGIN DELETE FROM base; END;`,
			"INSERT INTO v (a) VALUES ('z');",
		],
	].map(([label, schema, file]) => ({
		file: file as string,
		label: `view trigger: ${label as string}`,
		schema: schema as string,
	}))
}

/** Every case of the corpus */
export function scopeCorpus(): ScopeCase[] {
	return [
		...d1Cases(),
		...triggerCases(),
		...ftsCases(),
		...viewTriggerCases(),
		...shapes().map((file) => ({ file, label: `shape: ${file}`, schema: SHAPES_SCHEMA })),
	]
}
