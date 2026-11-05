import { beforeAll, describe, expect, it } from "vitest"
import { ddlFindings } from "./pg-ddl.ts"
import { historyFacts } from "./pg-history.ts"
import type { Node } from "./pg-nodes.ts"
import { loadPostgresParser, postgresParser } from "./pg-parser.ts"

beforeAll(() => loadPostgresParser())

/** The top-level statement node of `sql`, by its type */
function statementOf(sql: string): [string, Node] {
	const [stmt] = postgresParser().parseSync(sql).stmts as Array<{ stmt: Node }>
	const [type, node] = Object.entries((stmt as { stmt: Node }).stmt)[0] as [string, Node]
	return [type, node]
}

/** The levels, and any drops or notes, of `sql`'s DDL findings */
const rated = (sql: string) => ddlFindings(...statementOf(sql), historyFacts(undefined, "public"))

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
		for (const sql of ["ALTER TABLE t ADD COLUMN n int NOT NULL DEFAULT 0", "ALTER TABLE t ADD COLUMN n int"])
			expect(rated(sql), sql).toEqual([])
		/* a generated or identity column fills each row, so NOT NULL holds: only the rewrite is warned of (P6) */
		for (const sql of [
			"ALTER TABLE t ADD COLUMN n int NOT NULL GENERATED ALWAYS AS (1) STORED",
			"ALTER TABLE t ADD COLUMN n int NOT NULL GENERATED ALWAYS AS IDENTITY",
		])
			expect(
				rated(sql)?.map((finding) => finding.level),
				sql,
			).toEqual(["lock"])
		expect(rated("ALTER TABLE t ADD COLUMN at timestamptz DEFAULT clock_timestamp()")?.[0]?.level).toBe("lock")
		expect(rated("ALTER TABLE t ADD COLUMN r float8 DEFAULT random()")?.[0]?.level).toBe("lock")
	})
})

/** The NOT VALID recipe every scanning constraint names */
const LATER = "add it NOT VALID, then VALIDATE CONSTRAINT in a later file"

describe("ddlFindings: an ALTER TABLE's constraints, defaults and other commands", () => {
	it("warns of a scan for a foreign key or check validated, and of none NOT VALID or for a key", () => {
		expect(rated("ALTER TABLE t ADD CONSTRAINT f FOREIGN KEY (a) REFERENCES u")?.[0]?.level).toBe("lock")
		expect(rated("ALTER TABLE t ADD CHECK (a > 0)")?.[0]?.level).toBe("lock")
		expect(rated("ALTER TABLE t ADD CONSTRAINT f FOREIGN KEY (a) REFERENCES u NOT VALID")).toEqual([])
		expect(rated("ALTER TABLE t ADD PRIMARY KEY (a)")).toEqual([])
	})

	/* r18 P16: a foreign key scans its table and blocks writes to both tables; it rewrites nothing */
	it("says what an added foreign key scans and blocks, naming both tables", () => {
		expect(rated("ALTER TABLE t ADD CONSTRAINT f FOREIGN KEY (a) REFERENCES s.u (id)")).toEqual([
			{ level: "lock", note: `scans t, blocking writes to t and s.u; ${LATER}` },
		])
		expect(rated("ALTER TABLE ONLY t ADD FOREIGN KEY (a) REFERENCES t")).toEqual([
			{ level: "lock", note: `scans t, blocking writes to t; ${LATER}` },
		])
	})

	/* r18 P14: a rule turned on or off is a rule change, rated by its family's rule */
	it.each(["DISABLE RULE r", "ENABLE RULE r", "ENABLE ALWAYS RULE r", "ENABLE REPLICA RULE r"])(
		"rates ALTER TABLE t %s by the rule family's rule",
		(command) => {
			expect(rated(`ALTER TABLE t ${command}`)).toEqual([
				{ level: "unsafe", note: "comb rates every rule change unsafe; approve it in the file" },
			])
		},
	)

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

	/* r18 P11: an index or a materialized view moved, or a whole tablespace's relations, is rewritten too */
	it("warns of the rewrite for an index or materialized view moved, and for every relation of a tablespace", () => {
		const REWRITE = [{ level: "lock", note: "rewrites or scans the table under an exclusive lock" }]
		for (const sql of [
			"ALTER INDEX t_v SET TABLESPACE fast",
			"ALTER MATERIALIZED VIEW mv SET TABLESPACE fast",
			"ALTER MATERIALIZED VIEW mv SET ACCESS METHOD heap",
		])
			expect(rated(sql), sql).toEqual(REWRITE)
		expect(rated("ALTER TABLE ALL IN TABLESPACE pg_default SET TABLESPACE fast")).toEqual([
			{ level: "lock", note: "moves every table in tablespace pg_default, each rewritten under an exclusive lock" },
		])
		expect(rated("ALTER INDEX ALL IN TABLESPACE slow OWNED BY r SET TABLESPACE fast")).toEqual([
			{ level: "lock", note: "moves every index in tablespace slow, each rewritten under an exclusive lock" },
		])
		expect(rated("ALTER INDEX t_v SET (fillfactor = 70)")).toEqual([])
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

/* P16 of the 0.14.1 review */
describe("ddlFindings: an identity made ALWAYS", () => {
	it("rates SET GENERATED ALWAYS cautious, as a deployed insert that writes the id then fails, and BY DEFAULT nothing", () => {
		expect(rated("ALTER TABLE t ALTER COLUMN id SET GENERATED ALWAYS")).toEqual([
			{
				level: "cautious",
				note: "makes id GENERATED ALWAYS: an insert that writes it then fails unless it says OVERRIDING SYSTEM VALUE",
			},
		])
		expect(rated("ALTER TABLE t ALTER COLUMN id SET GENERATED BY DEFAULT")).toEqual([])
		/* an identity added ALWAYS to a column a deployed insert writes breaks that insert the same way */
		expect(rated("ALTER TABLE t ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY")).toEqual([
			{
				level: "cautious",
				note: "makes id GENERATED ALWAYS: an insert that writes it then fails unless it says OVERRIDING SYSTEM VALUE",
			},
		])
		expect(rated("ALTER TABLE t ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY")).toEqual([])
		expect(
			rated("ALTER TABLE t ALTER COLUMN id SET GENERATED ALWAYS RESTART")?.map((finding) => finding.level),
		).toEqual(["cautious", "cautious"])
	})
})

describe("ddlFindings: renames, moves, enum values and drops", () => {
	it("rates a rename or move of a table, column, view, type, domain or schema unsafe, of an index or constraint cautious", () => {
		for (const sql of [
			"ALTER TABLE t RENAME TO u",
			"ALTER TABLE t RENAME COLUMN a TO b",
			"ALTER VIEW v RENAME TO w",
			"ALTER SCHEMA s RENAME TO r",
			"ALTER TABLE t SET SCHEMA s",
			"ALTER TYPE e SET SCHEMA s",
			"ALTER DOMAIN d RENAME TO e",
			"ALTER DOMAIN d SET SCHEMA s",
		])
			expect(rated(sql), sql).toEqual([{ level: "unsafe" }])
		expect(rated("ALTER INDEX i RENAME TO j")).toEqual([{ level: "cautious" }])
		expect(rated("ALTER TABLE t RENAME CONSTRAINT a TO b")).toEqual([{ level: "cautious" }])
		expect(rated("ALTER DOMAIN d RENAME CONSTRAINT a TO b")).toEqual([{ level: "cautious" }])
		/* a sequence moved keeps its values */
		expect(rated("ALTER SEQUENCE q SET SCHEMA s")).toEqual([])
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
