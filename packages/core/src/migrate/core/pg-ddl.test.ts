import { beforeAll, describe, expect, it } from "vitest"
import { freshStart } from "./classify-write.ts"
import { ddlFindings, followFresh } from "./pg-ddl.ts"
import { historyFacts } from "./pg-history.ts"
import { type Node, nodesOf } from "./pg-nodes.ts"
import { loadPostgresParser, postgresParser } from "./pg-parser.ts"
import { extractSchema } from "./schema.ts"

beforeAll(() => loadPostgresParser())

/** The top-level statement node of `sql`, by its type */
function statementOf(sql: string): [string, Node] {
	const [stmt] = postgresParser().parseSync(sql).stmts as Array<{ stmt: Node }>
	const [type, node] = Object.entries((stmt as { stmt: Node }).stmt)[0] as [string, Node]
	return [type, node]
}

/** The levels, and any drops or notes, of `sql`'s DDL findings */
const rated = (sql: string) => ddlFindings(...statementOf(sql))

describe("ddlFindings: an ALTER TABLE, command by command", () => {
	it("rates a dropped column, a retype and SET NOT NULL unsafe, the last two with a rewrite", () => {
		expect(rated('ALTER TABLE "public"."post" DROP COLUMN body')).toEqual([
			{ drops: ["DROP COLUMN public.post.body"], level: "unsafe" },
		])
		for (const sql of ["ALTER TABLE t ALTER COLUMN a TYPE int", "ALTER TABLE t ALTER COLUMN a SET NOT NULL"])
			expect(rated(sql)?.map((finding) => finding.level)).toEqual(["unsafe", "lock"])
	})

	it("rates an added column NOT NULL without a default unsafe, and a volatile default a rewrite", () => {
		expect(rated("ALTER TABLE t ADD COLUMN n int NOT NULL")).toEqual([{ level: "unsafe" }])
		for (const sql of [
			"ALTER TABLE t ADD COLUMN n int NOT NULL DEFAULT 0",
			"ALTER TABLE t ADD COLUMN n int NOT NULL GENERATED ALWAYS AS (1) STORED",
			"ALTER TABLE t ADD COLUMN n int NOT NULL GENERATED ALWAYS AS IDENTITY",
			"ALTER TABLE t ADD COLUMN n int",
		])
			expect(rated(sql), sql).toEqual([])
		expect(rated("ALTER TABLE t ADD COLUMN at timestamptz DEFAULT clock_timestamp()")?.[0]?.level).toBe("lock")
		expect(rated("ALTER TABLE t ADD COLUMN r float8 DEFAULT random()")?.[0]?.level).toBe("lock")
	})
})

describe("ddlFindings: an ALTER TABLE's constraints, defaults and other commands", () => {
	it("warns of a scan for a foreign key or check validated, and of none NOT VALID or for a key", () => {
		expect(rated("ALTER TABLE t ADD CONSTRAINT f FOREIGN KEY (a) REFERENCES u")?.[0]?.level).toBe("lock")
		expect(rated("ALTER TABLE t ADD CHECK (a > 0)")?.[0]?.level).toBe("lock")
		expect(rated("ALTER TABLE t ADD CONSTRAINT f FOREIGN KEY (a) REFERENCES u NOT VALID")).toEqual([])
		expect(rated("ALTER TABLE t ADD PRIMARY KEY (a)")).toEqual([])
	})

	it("rates a dropped default, constraint, owner or trigger cautious, and a set default nothing", () => {
		for (const sql of [
			"ALTER TABLE t ALTER COLUMN a DROP DEFAULT",
			"ALTER TABLE t DROP CONSTRAINT c",
			"ALTER TABLE t OWNER TO r",
			"ALTER TABLE t DISABLE TRIGGER x",
			"ALTER TABLE t DETACH PARTITION p",
		])
			expect(rated(sql), sql).toEqual([{ level: "cautious" }])
		expect(rated("ALTER TABLE t ALTER COLUMN a SET DEFAULT 1")).toEqual([])
		expect(rated("ALTER TABLE t ENABLE ROW LEVEL SECURITY")).toEqual([
			{ level: "cautious", note: "changes which rows each role sees on t" },
		])
	})

	it("rates the commands that change no value with nothing, and any other unsafe, in words", () => {
		for (const sql of [
			"ALTER TABLE t VALIDATE CONSTRAINT c",
			"ALTER TABLE t ALTER COLUMN a DROP NOT NULL",
			"ALTER TABLE t SET (fillfactor = 70)",
		])
			expect(rated(sql), sql).toEqual([])
		expect(rated("ALTER TABLE t ENABLE TRIGGER x")).toEqual([
			{ level: "unsafe", note: "comb does not recognize ALTER TABLE … ENABLE TRIG; approve it in the file" },
		])
	})

	it("rates a composite type's attribute dropped or retyped unsafe, and an index's or view's alter nothing", () => {
		expect(rated("ALTER TYPE comp DROP ATTRIBUTE x")).toEqual([{ level: "unsafe" }])
		expect(rated("ALTER TYPE comp ALTER ATTRIBUTE x TYPE int")).toEqual([{ level: "unsafe" }])
		expect(rated("ALTER TYPE comp ADD ATTRIBUTE y int")).toEqual([])
		expect(rated("ALTER INDEX i SET (fillfactor = 70)")).toEqual([])
		expect(rated("ALTER VIEW v ALTER COLUMN a SET DEFAULT 1")).toEqual([])
	})
})

/* the commands that rewrite the whole table under an ACCESS EXCLUSIVE lock warn of it, as a retype does */
describe("ddlFindings: an ALTER TABLE that rewrites the table", () => {
	it("warns of the rewrite for a new tablespace or access method", () => {
		for (const sql of ["ALTER TABLE t SET TABLESPACE fast", "ALTER TABLE t SET ACCESS METHOD heap"])
			expect(rated(sql), sql).toEqual([{ level: "lock", note: "rewrites or scans the table under an exclusive lock" }])
	})

	it("rates SET LOGGED and SET UNLOGGED cautious, with the rewrite, and says what UNLOGGED loses", () => {
		expect(rated("ALTER TABLE t SET LOGGED")).toEqual([
			{ level: "cautious" },
			{ level: "lock", note: "rewrites or scans the table under an exclusive lock" },
		])
		expect(rated("ALTER TABLE t SET UNLOGGED")).toEqual([
			{ level: "cautious", note: "makes t unlogged: its rows are emptied after a crash and not replicated" },
			{ level: "lock", note: "rewrites or scans the table under an exclusive lock" },
		])
	})
})

describe("ddlFindings: renames, moves, enum values and drops", () => {
	it("rates a rename or move of a table, column, view, type or schema unsafe, of an index cautious", () => {
		for (const sql of [
			"ALTER TABLE t RENAME TO u",
			"ALTER TABLE t RENAME COLUMN a TO b",
			"ALTER VIEW v RENAME TO w",
			"ALTER SCHEMA s RENAME TO r",
			"ALTER TABLE t SET SCHEMA s",
			"ALTER TYPE e SET SCHEMA s",
		])
			expect(rated(sql), sql).toEqual([{ level: "unsafe" }])
		expect(rated("ALTER INDEX i RENAME TO j")).toEqual([{ level: "cautious" }])
		expect(rated("ALTER TABLE t RENAME CONSTRAINT a TO b")).toEqual([{ level: "cautious" }])
		/* a sequence moved keeps its values; a domain renamed is M85's (pg-ddl rates it nothing yet) */
		expect(rated("ALTER SEQUENCE q SET SCHEMA s")).toEqual([])
		expect(rated("ALTER DOMAIN d RENAME TO e")).toEqual([])
	})

	it("rates an enum value renamed unsafe, and one added nothing", () => {
		expect(rated("ALTER TYPE e RENAME VALUE 'a' TO 'b'")).toEqual([{ level: "unsafe" }])
		expect(rated("ALTER TYPE e ADD VALUE 'c'")).toEqual([])
	})

	it("rates a drop by its kind, naming the tables and indexes it drops", () => {
		expect(rated("DROP TABLE a, public.b CASCADE")).toEqual([
			{ drops: ["DROP TABLE a", "DROP TABLE public.b"], level: "unsafe" },
		])
		expect(rated("DROP INDEX i")).toEqual([{ drops: ["DROP INDEX i"], level: "cautious" }])
		expect(rated("DROP SCHEMA s")).toEqual([{ drops: [], level: "unsafe" }])
		expect(rated("DROP VIEW v")).toEqual([{ drops: [], level: "cautious" }])
		for (const sql of ["DROP DATABASE d", "DROP ROLE r", "DROP OWNED BY r"])
			expect(rated(sql), sql).toEqual([{ level: "unsafe" }])
	})

	it("rates nothing for a node that is not DDL these rules read", () => {
		expect(rated("SELECT 1")).toBeUndefined()
	})
})

/** The facts of a history that made `had (a)` */
const facts = () => historyFacts(extractSchema("CREATE TABLE had (a int);", undefined, "postgres"), "public")

/** `fresh` after each statement of `sql`, followed in order */
function after(sql: string) {
	const ctx = { facts: facts(), fresh: freshStart() }
	for (const [type, node] of nodesOf(postgresParser().parseSync(sql).stmts)) followFresh(type, node, ctx)
	return ctx.fresh
}

describe("followFresh: what a file makes new, keyed as the parser names it", () => {
	it("makes a table new without IF NOT EXISTS and a name the history does not show", () => {
		expect([...after('CREATE TABLE U&"\\0061" (id int)').tables]).toEqual(["a"])
		expect([...after("CREATE TABLE IF NOT EXISTS b (id int)").tables]).toEqual([])
		expect([...after("CREATE TABLE had (id int)").tables]).toEqual([])
	})

	it("adds a column new, folded, unless IF NOT EXISTS or the table had it", () => {
		expect(after("ALTER TABLE had ADD COLUMN Note text").columns).toEqual(new Map([["had", new Set(["note"])]]))
		expect(after("ALTER TABLE had ADD COLUMN IF NOT EXISTS n int").columns).toEqual(new Map())
		expect(after("ALTER TABLE had ADD COLUMN a int, DROP COLUMN x").columns).toEqual(new Map())
	})

	it("keeps a table fresh through an INSERT … VALUES, never an INSERT … SELECT", () => {
		expect([...after("CREATE TABLE n (id int); INSERT INTO n VALUES (1)").tables]).toEqual(["n"])
		expect([...after("CREATE TABLE n (id int); INSERT INTO n SELECT 1").tables]).toEqual([])
		expect([...after("CREATE TABLE n (id int); INSERT INTO n DEFAULT VALUES").tables]).toEqual(["n"])
	})
})
