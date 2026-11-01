/**
 * P21 of r19: a Postgres statement comb does not recognize is named by its parse tree's node, as
 * Postgres's command tag names it, never by its first two words ("ALTER DEFAULT", "CREATE TEXT",
 * "CREATE USER" for a user mapping); and a PREPARE is rated as itself, a statement an EXECUTE runs
 * later, never as the statement it holds.
 */
import { describe, expect, it } from "vitest"
import { classifyMigration } from "./classify.ts"
import { extractSchema } from "./schema.ts"

/** `sql`'s rating after a table t, read as Postgres */
const rate = (sql: string, history = "") =>
	classifyMigration(sql, {
		before: extractSchema(`CREATE TABLE t (id int);${history}`, undefined, "postgres"),
		dialect: "postgres",
	})

describe("a Postgres statement comb does not recognize (P21 of r19)", () => {
	it.each([
		["ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO PUBLIC", "ALTER DEFAULT PRIVILEGES"],
		["CREATE ACCESS METHOD am TYPE TABLE HANDLER heap_tableam_handler", "CREATE ACCESS METHOD"],
		["IMPORT FOREIGN SCHEMA s FROM SERVER x INTO public", "IMPORT FOREIGN SCHEMA"],
		["CREATE TEXT SEARCH CONFIGURATION c (COPY = english)", "CREATE TEXT SEARCH CONFIGURATION"],
		["ALTER TEXT SEARCH CONFIGURATION c ALTER MAPPING FOR word WITH simple", "ALTER TEXT SEARCH CONFIGURATION"],
		["ALTER LARGE OBJECT 1 OWNER TO r", "ALTER LARGE OBJECT"],
		["CREATE OR REPLACE LANGUAGE plx HANDLER h", "CREATE LANGUAGE"],
		["CREATE USER MAPPING FOR u SERVER s", "CREATE USER MAPPING"],
		["CREATE STATISTICS s ON id, id FROM t", "CREATE STATISTICS"],
		["REASSIGN OWNED BY a TO b", "REASSIGN OWNED"],
		["CHECKPOINT", "CHECKPOINT"],
	])("names %j as Postgres's command tag does", (sql, tag) => {
		const rating = rate(sql)
		expect([rating.safety, rating.unsafeStatements]).toEqual([
			"unsafe",
			[`${sql} (comb does not recognize ${tag}; approve it in the file)`],
		])
	})
})

describe("a PREPARE (P21 of r19)", () => {
	it("is rated as itself, with a note that an EXECUTE runs it, and never as the statement it holds", () => {
		const rating = rate("PREPARE q AS DELETE FROM t;")
		expect([rating.safety, rating.unsafeStatements, rating.cautiousStatements]).toEqual([
			"cautious",
			[],
			["PREPARE q AS DELETE FROM t (prepares a statement for an EXECUTE, which comb rates by the statement it runs)"],
		])
	})

	it("leaves the EXECUTE rated by the statement it runs", () => {
		expect(rate("PREPARE q AS DELETE FROM t;\nEXECUTE q;").unsafeStatements.join("\n")).toContain("EXECUTE q")
	})
})

describe("an event trigger's WHEN TAG IN a text search kind (P21 of r19's sibling: one tag spelling)", () => {
	it("fires on a CREATE TEXT SEARCH CONFIGURATION, which Postgres tags so", () => {
		const history =
			"CREATE FUNCTION et() RETURNS event_trigger LANGUAGE plpgsql AS $$BEGIN END$$;\nCREATE EVENT TRIGGER e ON ddl_command_start WHEN TAG IN ('CREATE TEXT SEARCH CONFIGURATION') EXECUTE FUNCTION et();\n"
		const fired = rate("CREATE TEXT SEARCH CONFIGURATION c (COPY = english);", history)
		expect([...fired.unsafeStatements, ...fired.cautiousStatements].join("\n")).toContain("event trigger e")
	})
})
