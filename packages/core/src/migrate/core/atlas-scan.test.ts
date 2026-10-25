/**
 * atlas-scan.ts against Atlas itself: each file below was split by atlas 1.3.0 (`atlas migrate
 * apply --dry-run` on Postgres 17, .tmp/grunt/r15/m75/atlas-truth.ts), and the expected chunks or
 * refusal are Atlas's own output, word for word. A further 800 seeded random files matched it too
 * (.tmp/grunt/r15/m75/fuzz.ts).
 */
import { describe, expect, it } from "vitest"
import { atlasChunks, unterminated } from "./atlas-scan.ts"

/** The texts Atlas sends for `sql`, or its refusal */
function chunks(sql: string): string[] | { error: string } {
	try {
		return atlasChunks(sql).map((chunk) => chunk.text)
	} catch (error) {
		return { error: (error as Error).message.replace(/^Atlas cannot split this file: /, "") }
	}
}

// lookup-table: a file, and what atlas 1.3.0 sent Postgres for it, or why it refused it
const ATLAS: ReadonlyArray<readonly [string, string, string[] | { error: string }]> = [
	[
		"plain",
		"CREATE TABLE a (id int);\nCREATE TABLE b (id int);\n",
		["CREATE TABLE a (id int);", "CREATE TABLE b (id int);"],
	],
	["no trailing", "CREATE TABLE a (id int);\nDROP TABLE a", ["CREATE TABLE a (id int);", "DROP TABLE a"]],
	[
		"comments",
		"-- lead\n/* block */ CREATE TABLE a (id int); -- tail\n/* only a comment */\n",
		["CREATE TABLE a (id int);"],
	],
	[
		"trigger on begin column",
		"CREATE TABLE events (id int, begin int);\nCREATE TRIGGER t BEFORE UPDATE OF begin ON events FOR EACH ROW EXECUTE FUNCTION f();\nDROP TABLE events;\n",
		[
			"CREATE TABLE events (id int, begin int);",
			"CREATE TRIGGER t BEFORE UPDATE OF begin ON events FOR EACH ROW EXECUTE FUNCTION f();",
			"DROP TABLE events;",
		],
	],
	[
		"rule multi action",
		"CREATE RULE r AS ON INSERT TO events DO ALSO (INSERT INTO users VALUES (1, 'x'); DELETE FROM users);\n",
		["CREATE RULE r AS ON INSERT TO events DO ALSO (INSERT INTO users VALUES (1, 'x'); DELETE FROM users);"],
	],
	[
		"begin atomic",
		"CREATE FUNCTION g() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; SELECT 2; END;\nDROP TABLE users;\n",
		["CREATE FUNCTION g() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; SELECT 2; END;", "DROP TABLE users;"],
	],
	[
		"begin atomic case",
		"CREATE FUNCTION g(x int) RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT CASE WHEN x > 0 THEN 1 ELSE 2 END; END;\nDROP TABLE users;\n",
		[
			"CREATE FUNCTION g(x int) RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT CASE WHEN x > 0 THEN 1 ELSE 2 END; END;",
			"DROP TABLE users;",
		],
	],
	[
		"begin end block",
		"BEGIN TRANSACTION;\nCREATE TABLE a (id int);\nEND;\nDROP TABLE users;\n",
		["BEGIN TRANSACTION;\nCREATE TABLE a (id int);\nEND;", "DROP TABLE users;"],
	],
	[
		"begin unclosed",
		"BEGIN WORK;\nCREATE TABLE a (id int);\nCOMMIT;\nDROP TABLE users;\n",
		["BEGIN WORK;", "CREATE TABLE a (id int);", "COMMIT;", "DROP TABLE users;"],
	],
	[
		"dollar body",
		"CREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $$ BEGIN RETURN 1; END $$;\nDO $x$ BEGIN PERFORM 1; END $x$;\n",
		[
			"CREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $$ BEGIN RETURN 1; END $$;",
			"DO $x$ BEGIN PERFORM 1; END $x$;",
		],
	],
	["estring continuation", "SELECT E'a'\n'\\'; DROP TABLE users; --';\n", ["SELECT E'a'\n'\\';", "DROP TABLE users;"]],
	["estring escape", "SELECT E'\\'; DROP TABLE users; --';\n", ["SELECT E'\\';", "DROP TABLE users;"]],
	[
		"nested comment",
		"SELECT 1 /* a /* b */ ; DROP TABLE users; */ ;\n",
		["SELECT 1 /* a /* b */ ;", "DROP TABLE users;", "*/ ;"],
	],
	[
		"backtick",
		"SELECT '`'; SELECT 1 AS \"`\"; DROP TABLE users;\n",
		["SELECT '`';", 'SELECT 1 AS "`";', "DROP TABLE users;"],
	],
	[
		"paren semicolon",
		"CREATE TABLE a (id int CHECK (id > 0));\nSELECT (1);\n",
		["CREATE TABLE a (id int CHECK (id > 0));", "SELECT (1);"],
	],
	["unclosed paren", "SELECT (1;\nDROP TABLE users;\n", { error: "1:8: unclosed '('" }],
	["unexpected paren", "SELECT 1);\nDROP TABLE users;\n", { error: "1:9: unexpected ')'" }],
	["unclosed quote", "SELECT 'x;\nDROP TABLE users;\n", { error: "1:8: unclosed quote '\\''" }],
	["unclosed dollar", "SELECT $$x;\nDROP TABLE users;\n", ["SELECT $$x;\nDROP TABLE users;"]],
	[
		"delimiter go",
		"-- atlas:delimiter GO\n\nCREATE TABLE x (id int)\nGO\nDROP TABLE users\nGO\n",
		["CREATE TABLE x (id int)", "DROP TABLE users"],
	],
	[
		"delimiter go dollar",
		"-- atlas:delimiter GO\n\nCREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $$ BEGIN RETURN 1; GO END $$\nGO\nDROP TABLE users\nGO\n",
		["CREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $$ BEGIN RETURN 1; GO END $$", "DROP TABLE users"],
	],
	[
		"delimiter go string",
		"-- atlas:delimiter GO\nSELECT 'GO'; SELECT 2\nGO\nDROP TABLE users GO\n",
		["SELECT 'GO'; SELECT 2", "DROP TABLE users"],
	],
	["delimiter go midword", "-- atlas:delimiter GO\nCREATE TABLE GOOD (id int)\nGO\n", ["CREATE TABLE", "OD (id int)"]],
	["delimiter go comment", "-- atlas:delimiter GO\n-- a GO comment\nSELECT 1 /* GO */\nGO\n", ["SELECT 1 /* GO */"]],
	[
		"delimiter dollar",
		"-- atlas:delimiter $$\nCREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $$ BEGIN RETURN 1; END $$\nSELECT 2$$\n",
		["CREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS", "BEGIN RETURN 1; END", "SELECT 2"],
	],
	[
		"delimiter newlines",
		"-- atlas:delimiter \\n\\n\nCREATE TABLE a (id int);\nCREATE TABLE b (id int);\n\nDROP TABLE users;\n",
		["CREATE TABLE a (id int);\nCREATE TABLE b (id int);", "DROP TABLE users;"],
	],
	[
		"delimiter semicolon begin",
		"-- atlas:delimiter ;\nCREATE FUNCTION g() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; END;\n",
		["CREATE FUNCTION g() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; END;"],
	],
	[
		"delimiter crlf",
		"-- atlas:delimiter GO\r\nCREATE TABLE a (id int)\r\nGO\r\nDROP TABLE users\r\nGO\r\n",
		["CREATE TABLE a (id int)", "DROP TABLE users"],
	],
	[
		"delimiter trailing space",
		"-- atlas:delimiter GO \nCREATE TABLE a (id int) GO \nDROP TABLE users GO \n",
		["CREATE TABLE a (id int)", "DROP TABLE users"],
	],
	["delimiter empty", "-- atlas:delimiter\nCREATE TABLE a (id int);\n", { error: "empty delimiter" }],
	["delimiter only line", "-- atlas:delimiter GO", { error: '1:0: no input found after delimiter "GO"' }],
	[
		"delimiter second line",
		"-- head\n-- atlas:delimiter GO\nCREATE TABLE a (id int)\nGO\n",
		["CREATE TABLE a (id int)\nGO"],
	],
	[
		"delimiter paren",
		"-- atlas:delimiter GO\nSELECT (1 GO 2)\nGO\nDROP TABLE users\nGO\n",
		["SELECT (1 GO 2)", "DROP TABLE users"],
	],
	["delimiter no space prefix", "--atlas:delimiter GO\nCREATE TABLE a (id int);\n", ["CREATE TABLE a (id int);"]],
	[
		"delimiter unclosed dollar",
		"-- atlas:delimiter GO\nSELECT $$ x GO\nDROP TABLE users\n",
		["SELECT $$ x GO\nDROP TABLE users"],
	],
	[
		"mysql delimiter cmd",
		"DELIMITER //\nCREATE TABLE a (id int); CREATE TABLE b (id int)//\nDROP TABLE users//\n",
		["CREATE TABLE a (id int); CREATE TABLE b (id int)", "DROP TABLE users"],
	],
	[
		"multibyte",
		"SELECT 'ž€😀';\nCREATE TABLE \"ž😀\" (id int);\nDROP TABLE users;\n",
		["SELECT 'ž€😀';", 'CREATE TABLE "ž😀" (id int);', "DROP TABLE users;"],
	],
	["only comments", "-- nothing\n/* here */\n", []],
	["empty statements", ";;\nSELECT 1;;\n", [";", ";", "SELECT 1;", ";"]],
	["unterminated block comment", "SELECT 1; /* open\nDROP TABLE users;\n", ["SELECT 1;", "/* open\nDROP TABLE users;"]],
	["dash eof", "SELECT 1; --", ["SELECT 1;", "--"]],
	[
		"begin in identifier",
		"CREATE TABLE xbegin (id int); SELECT 1 AS begin_ FROM xbegin;\nDROP TABLE users;\n",
		["CREATE TABLE xbegin (id int);", "SELECT 1 AS begin_ FROM xbegin;", "DROP TABLE users;"],
	],
	["error line two", "SELECT 1;\nSELECT 'é' AS é, (1;\n", { error: "2:20: unclosed '('" }],
	["unclosed double quote", 'SELECT "x;\nDROP TABLE users;\n', { error: "1:8: unclosed quote '\"'" }],
	["delimiter cmd no space", "DELIMITERx;\nSELECT 1;\n", ["DELIMITERx;", "SELECT 1;"]],
	["delimiter cmd quoted", "DELIMITER 'a''b'\nSELECT 1a'b\nDROP TABLE users a'b\n", ["SELECT 1", "DROP TABLE users"]],
	[
		"begin atomic unclosed",
		"CREATE FUNCTION g() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1;\nDROP TABLE users;\n",
		["CREATE FUNCTION g() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1;", "DROP TABLE users;"],
	],
]

describe("atlasChunks: the chunks atlas 1.3.0 sends Postgres", () => {
	it.each(ATLAS)("splits %s as Atlas does", (_, sql, expected) => {
		expect(chunks(sql)).toEqual(expected)
	})

	it("refuses a file Atlas refuses, with Atlas's reason", () => {
		expect(() => atlasChunks("SELECT 'x;")).toThrow("Atlas cannot split this file: 1:8: unclosed quote '\\''")
	})
})

describe("atlasChunks: the comments before a chunk, which Atlas leaves out", () => {
	it("keeps them beside the chunk, and none past the last", () => {
		expect(atlasChunks("-- a\n/* b */\nSELECT 1;\n-- c\nSELECT 2; -- d\n")).toEqual([
			{ lead: "-- a\n/* b */", text: "SELECT 1;" },
			{ lead: "-- c", text: "SELECT 2;" },
		])
	})

	it("reads them from past a delimiter directive and a DELIMITER line", () => {
		expect(atlasChunks("-- atlas:delimiter GO\n-- a\nSELECT 1 GO\n")).toEqual([{ lead: "-- a", text: "SELECT 1" }])
		expect(atlasChunks("-- a\nDELIMITER //\n-- b\nSELECT 1//\n")).toEqual([{ lead: "-- b", text: "SELECT 1" }])
	})

	it("puts them before the chunk's text, on a line of their own, and the ; off", () => {
		expect(atlasChunks("-- a\nSELECT 1;\nSELECT 2;").map(unterminated)).toEqual(["-- a\nSELECT 1", "SELECT 2"])
		expect(atlasChunks("-- a\n;").map(unterminated)).toEqual([""])
		expect(atlasChunks("-- atlas:delimiter GO\n-- a\nSELECT 1 GO").map(unterminated)).toEqual(["-- a\nSELECT 1"])
	})
})
