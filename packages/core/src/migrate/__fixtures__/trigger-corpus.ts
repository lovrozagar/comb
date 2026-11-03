/**
 * SL2 of r22: trigger shapes that name `begin`, `end` and `case` where SQLite reads them as
 * identifiers or as a CASE, in the WHEN, the ON and the body. Each case is the statements SQLite
 * reads in it, in order; its file is them joined, each ended by `;`. A statement after the trigger
 * fires it, so a trigger split wrong shows in the rows as well as in sqlite_master.
 */

/** The tables every case runs over: `begin` and `end` are columns of ev, and `begin` is a table */
export const CORPUS_SETUP =
	"CREATE TABLE ev (id INTEGER PRIMARY KEY, begin INTEGER, end INTEGER, kind TEXT);\nCREATE TABLE log (x);\nCREATE TABLE begin (id INTEGER PRIMARY KEY, v INTEGER);\n"

const AFTER = "INSERT INTO log VALUES ('after')"
const FIRE = "INSERT INTO ev (begin, end) VALUES (1, 2)"

/** Each case: what it shows, and the statements SQLite reads in its file */
export const CORPUS: ReadonlyArray<{ label: string; statements: readonly string[] }> = [
	{
		label: "SET end in the body",
		statements: [
			"CREATE TRIGGER tr AFTER INSERT ON ev BEGIN UPDATE ev SET end = 1 WHERE id = new.id; END",
			FIRE,
			AFTER,
		],
	},
	{
		label: "new.end in the body",
		statements: ["CREATE TRIGGER tr AFTER INSERT ON ev BEGIN INSERT INTO log VALUES (new.end); END", FIRE, AFTER],
	},
	{
		label: "new.begin in the body",
		statements: ["CREATE TRIGGER tr AFTER INSERT ON ev BEGIN INSERT INTO log VALUES (new.begin); END", FIRE, AFTER],
	},
	{
		label: "ON begin, a table",
		statements: [
			"CREATE TRIGGER tr AFTER INSERT ON begin BEGIN INSERT INTO log VALUES (new.v); END",
			"INSERT INTO begin (v) VALUES (7)",
			AFTER,
		],
	},
	{
		label: "UPDATE OF end",
		statements: [
			"CREATE TRIGGER tr AFTER UPDATE OF end ON ev BEGIN INSERT INTO log VALUES (1); END",
			FIRE,
			"UPDATE ev SET end = 5",
			AFTER,
		],
	},
	{
		label: "new.begin and new.end in the WHEN",
		statements: [
			"CREATE TRIGGER tr AFTER INSERT ON ev WHEN new.begin > 0 AND new.end IS NOT NULL BEGIN INSERT INTO log VALUES (new.begin); END",
			FIRE,
			AFTER,
		],
	},
	{
		label: "CASE in the WHEN and nested in the body",
		statements: [
			"CREATE TRIGGER tr AFTER INSERT ON ev WHEN CASE new.begin WHEN 1 THEN 1 ELSE 0 END BEGIN\n  UPDATE ev SET kind = CASE WHEN new.end > new.begin THEN 'span' ELSE CASE new.end WHEN 0 THEN 'zero' END END WHERE id = new.id;\n  INSERT INTO log VALUES (new.end);\nEND",
			FIRE,
			AFTER,
		],
	},
	{
		label: "two lowercase triggers back to back",
		statements: [
			"create trigger a after insert on ev begin insert into log values (new.begin); end",
			"create trigger b after insert on ev begin insert into log values (new.end); end",
			FIRE,
			AFTER,
		],
	},
	{
		label: "a comment between END and its ;, and END; in a literal",
		statements: [
			"CREATE TRIGGER tr AFTER INSERT ON ev BEGIN INSERT INTO log VALUES ('END;'); END /* done */",
			FIRE,
			AFTER,
		],
	},
	{
		label: "begin and end outside a trigger",
		statements: [FIRE, "UPDATE ev SET end = begin + 1, kind = CASE WHEN begin > 0 THEN 'on' END", AFTER],
	},
	{
		label: "control: quoted",
		statements: [
			'CREATE TRIGGER tr AFTER INSERT ON ev BEGIN UPDATE ev SET "end" = 1 WHERE id = new.id; END',
			FIRE,
			AFTER,
		],
	},
]

/** A case's file: its statements, each ended by `;` on a line of its own */
export const corpusFile = (statements: readonly string[]): string => statements.map((sql) => `${sql};\n`).join("")
