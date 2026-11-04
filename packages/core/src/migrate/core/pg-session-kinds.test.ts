/**
 * The statement kinds of pg-session-kinds.ts (PA1 of r22b), each named by a statement Postgres's
 * parser reads as that kind, and each kind doing to a file's run what its table says: a kind that
 * sets the session ends its run, one that stores what it calls runs none of it, one that reads no
 * rows runs no stored code, a definition no statement names makes a later statement on rows end its run.
 */
import { beforeAll, describe, expect, it } from "vitest"
import { loadPostgresParser } from "./pg-parser.ts"
import { OPAQUE, ROWLESS, ROWLESS_COMMANDS, SETS, STORES } from "./pg-session-kinds.ts"
import { sessionRuns } from "./pg-session.ts"
import { pgRead } from "./pg-split.ts"

beforeAll(loadPostgresParser)

/* a statement of each kind, holding a session-setting call where the kind stores an expression */
const SAMPLES: Readonly<Record<string, string>> = {
	AlterDefaultPrivilegesStmt: "ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO r;",
	AlterEnumStmt: "ALTER TYPE e ADD VALUE 'z';",
	AlterExtensionStmt: "ALTER EXTENSION citext UPDATE;",
	AlterFunctionStmt: "ALTER FUNCTION f() STABLE;",
	AlterObjectSchemaStmt: "ALTER TABLE t SET SCHEMA s;",
	AlterOwnerStmt: "ALTER FUNCTION f() OWNER TO r;",
	AlterPolicyStmt: "ALTER POLICY p ON t USING (set_config('a.b', 'x', false) = 'x');",
	AlterRoleStmt: "ALTER ROLE r NOLOGIN;",
	AlterSeqStmt: "ALTER SEQUENCE q RESTART;",
	CallStmt: "CALL p();",
	CommentStmt: "COMMENT ON TABLE t IS 'x';",
	CompositeTypeStmt: "CREATE TYPE ct AS (a int);",
	CreateCastStmt: "CREATE CAST (int AS text) WITH FUNCTION f(int);",
	CreateDomainStmt: "CREATE DOMAIN d AS text CHECK (set_config('a.b', VALUE, false) = VALUE);",
	CreateEnumStmt: "CREATE TYPE e AS ENUM ('a');",
	CreateEventTrigStmt: "CREATE EVENT TRIGGER e ON ddl_command_end EXECUTE FUNCTION f();",
	CreateExtensionStmt: "CREATE EXTENSION citext;",
	CreateFunctionStmt: "CREATE FUNCTION g() RETURNS text LANGUAGE sql AS $$ SELECT set_config('a.b', 'x', false) $$;",
	CreateOpClassStmt: "CREATE OPERATOR CLASS c FOR TYPE int USING btree AS OPERATOR 1 <;",
	CreatePolicyStmt: "CREATE POLICY p ON t USING (set_config('a.b', 'x', false) = 'x');",
	CreateRoleStmt: "CREATE ROLE r;",
	CreateSchemaStmt: "CREATE SCHEMA s;",
	CreateSeqStmt: "CREATE SEQUENCE q;",
	CreateStatsStmt: "CREATE STATISTICS s ON a, b FROM t;",
	CreateStmt: "CREATE TABLE u (a text DEFAULT set_config('a.b', 'x', false));",
	CreateTrigStmt: "CREATE TRIGGER tr BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION f();",
	DefineStmt: "CREATE AGGREGATE agg(int) (SFUNC = int4pl, STYPE = int);",
	DiscardStmt: "DISCARD ALL;",
	DoStmt: "DO $$ BEGIN END $$;",
	DropRoleStmt: "DROP ROLE r;",
	DropStmt: "DROP TABLE t;",
	GrantRoleStmt: "GRANT r TO s;",
	GrantStmt: "GRANT SELECT ON t TO r;",
	ListenStmt: "LISTEN c;",
	LoadStmt: "LOAD 'auto_explain';",
	NotifyStmt: "NOTIFY c;",
	PrepareStmt: "PREPARE q AS SELECT 1;",
	RenameStmt: "ALTER TABLE t RENAME TO u;",
	RuleStmt: "CREATE RULE r AS ON INSERT TO t DO ALSO SELECT set_config('a.b', 'x', false);",
	SecLabelStmt: "SECURITY LABEL ON TABLE t IS 'x';",
	TransactionStmt: "SAVEPOINT s;",
	UnlistenStmt: "UNLISTEN c;",
	VariableSetStmt: "SET LOCAL lock_timeout = 0;",
	ViewStmt: "CREATE VIEW v AS SELECT set_config('a.b', 'x', false);",
}

/* an ALTER TABLE command of each kind that reads no rows */
const COMMANDS: Readonly<Record<string, string>> = {
	AT_ChangeOwner: "OWNER TO r",
	AT_ColumnDefault: "ALTER COLUMN id SET DEFAULT 1",
	AT_DetachPartition: "DETACH PARTITION p",
	AT_DisableRowSecurity: "DISABLE ROW LEVEL SECURITY",
	AT_DisableTrig: "DISABLE TRIGGER tr",
	AT_DropColumn: "DROP COLUMN id",
	AT_DropConstraint: "DROP CONSTRAINT c",
	AT_DropNotNull: "ALTER COLUMN id DROP NOT NULL",
	AT_EnableRowSecurity: "ENABLE ROW LEVEL SECURITY",
	AT_EnableTrig: "ENABLE TRIGGER tr",
	AT_ForceRowSecurity: "FORCE ROW LEVEL SECURITY",
	AT_NoForceRowSecurity: "NO FORCE ROW LEVEL SECURITY",
	AT_ReplicaIdentity: "REPLICA IDENTITY FULL",
	AT_SetStatistics: "ALTER COLUMN id SET STATISTICS 100",
	AT_SetStorage: "ALTER COLUMN id SET STORAGE PLAIN",
}

/** The one statement of `sql` as its kind, and for an ALTER TABLE its first command's */
function kindOf(sql: string): [string, string | undefined] {
	const tree = pgRead(sql).statements[0]?.tree as [{ stmt: Record<string, Record<string, unknown>> }]
	const [type, node] = Object.entries(tree[0].stmt)[0] as [string, Record<string, unknown>]
	const cmds = node["cmds"] as Array<{ AlterTableCmd: { subtype: string } }> | undefined
	return [type, cmds?.[0]?.AlterTableCmd.subtype]
}

const T = "CREATE TABLE t (id int);\n"
/* code no statement names, which every statement on rows may run */
const OPAQUE_CODE = "CREATE EXTENSION citext;"

/** Whether `sql`, between two plain files, beside the files `context` that only define, ends its run */
function ends(sql: string, context: readonly string[] = []): boolean {
	const files = [T, sql, T].map((text) => ({ read: pgRead(text) }))
	return sessionRuns(files, [...files, ...context.map((text) => ({ read: pgRead(text) }))]).length === 2
}

describe("the statement kinds a file's run is read by (PA1 of r22b)", () => {
	it("names each kind by a statement Postgres's parser reads as it", () => {
		const kinds = [...new Set([...SETS, ...STORES, ...ROWLESS, ...OPAQUE])].sort()
		expect(kinds.map((kind) => kindOf(SAMPLES[kind] ?? "")[0])).toEqual(kinds)
		const commands = [...ROWLESS_COMMANDS].sort()
		expect(commands.map((command) => kindOf(`ALTER TABLE t ${COMMANDS[command] ?? ""};`)[1])).toEqual(commands)
	})

	it.each([...SETS])("ends a run at %s, which sets the session whatever it holds", (kind) => {
		expect(ends(SAMPLES[kind] ?? "")).toBe(true)
	})

	/* an event trigger runs on every statement after it, so it ends every run, read on its own */
	it.each([...ROWLESS].filter((kind) => kind !== "CreateEventTrigStmt"))(
		"keeps %s in its run beside code no statement names, as it runs none on rows, nor what it stores",
		(kind) => {
			expect(ends(SAMPLES[kind] ?? "", [OPAQUE_CODE])).toBe(false)
		},
	)

	it.each([...OPAQUE])("ends a run at a statement on rows once the files define %s", (kind) => {
		expect([ends("INSERT INTO t VALUES (1);", [SAMPLES[kind] ?? ""]), ends("INSERT INTO t VALUES (1);")]).toEqual([
			true,
			false,
		])
	})

	it.each([...ROWLESS_COMMANDS])("keeps an ALTER TABLE of %s in its run beside code no statement names", (command) => {
		expect(ends(`ALTER TABLE t ${COMMANDS[command] ?? ""};`, [OPAQUE_CODE])).toBe(false)
	})

	it("ends a run at an ALTER TABLE that reads its rows beside code no statement names", () => {
		expect(ends("ALTER TABLE t ADD COLUMN y int DEFAULT 1;", [OPAQUE_CODE])).toBe(true)
	})
})
