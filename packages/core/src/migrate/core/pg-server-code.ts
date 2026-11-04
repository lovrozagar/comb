/**
 * The code a database already holds that a statement may run without naming it, which a run of
 * files read alone cannot see (PA1 of r22b, comb-9d's rulings): an event trigger, which runs on every
 * statement; code a statement runs as it uses it, an extension's or an operator's; and the tables a
 * trigger, a rule, a policy, or a default, check or index calling a function outside pg_catalog
 * holds code on, with the edges a write to one table reaches another by. The apply reads the
 * target's once, and the check replay the database it replays in, whose extensions devUrl's gave it;
 * pg-session.ts ends a file's run where a statement may run any of it.
 */
import type { PgTarget } from "./atlas-target.ts"
import { type Connect, loadPostgres } from "./pg-live-objects.ts"
import { pgRead } from "./pg-split.ts"
import { postgresOptionsOf } from "./pg-url.ts"

/** What a database holds of code */
type ServerCode = {
	/** whether it holds an event trigger, which runs on DDL */
	events: boolean
	/** whether it holds code a statement on rows runs as it uses it: an extension past plpgsql, an operator, cast, operator class or type of its own */
	opaque: boolean
	/** each function, procedure and aggregate name outside the system schemas, which an unqualified call may reach */
	names: readonly string[]
	/** each table and view a statement on whose rows may run code */
	tables: readonly string[]
	/** each pair of relations a flag on the first carries to the second: a table to a view reading it, a child to its parent, a table to the one its cascading key references */
	reaches: ReadonlyArray<readonly [string, string]>
	/** its LANGUAGE sql functions' definitions, parsed */
	trees: unknown[]
}

/* a database that holds no code of its own */
const NO_SERVER_CODE: ServerCode = { events: false, names: [], opaque: false, reaches: [], tables: [], trees: [] }

/* what comb takes a database it cannot read to hold: code every statement may run */
const UNREAD: ServerCode = { ...NO_SERVER_CODE, events: true, opaque: true }

/* the routines outside pg_catalog, by oid */
const OWN = "SELECT oid FROM pg_proc WHERE pronamespace <> 'pg_catalog'::regnamespace"

/** The objects of catalog `catalog` that depend on a routine outside pg_catalog */
const callsOwn = (catalog: string) =>
	`SELECT objid FROM pg_depend WHERE classid = '${catalog}'::regclass AND refclassid = 'pg_proc'::regclass AND refobjid IN (${OWN})`

/* code a statement on rows may run as it uses it, which no table holds */
const OPAQUE_CODE = /* @__PURE__ */ [
	"EXISTS (SELECT 1 FROM pg_extension WHERE extname <> 'plpgsql')",
	`EXISTS (SELECT 1 FROM pg_operator WHERE oprcode::oid IN (${OWN}) OR oprrest::oid IN (${OWN}) OR oprjoin::oid IN (${OWN}))`,
	`EXISTS (SELECT 1 FROM pg_cast WHERE castfunc IN (${OWN}))`,
	`EXISTS (SELECT 1 FROM pg_amproc WHERE amproc::oid IN (${OWN}))`,
	`EXISTS (${/* @__PURE__ */ callsOwn("pg_type")})`,
	`EXISTS (SELECT 1 FROM pg_constraint WHERE contypid <> 0 AND oid IN (${/* @__PURE__ */ callsOwn("pg_constraint")}))`,
].join(" OR ")

/* the relations that hold code a statement on their rows runs, by oid */
const HOLDS_CODE = /* @__PURE__ */ [
	"SELECT tgrelid FROM pg_trigger WHERE NOT tgisinternal",
	"SELECT ev_class FROM pg_rewrite WHERE rulename <> '_RETURN'",
	"SELECT polrelid FROM pg_policy",
	`SELECT adrelid FROM pg_attrdef WHERE oid IN (${/* @__PURE__ */ callsOwn("pg_attrdef")})`,
	`SELECT conrelid FROM pg_constraint WHERE conrelid <> 0 AND oid IN (${/* @__PURE__ */ callsOwn("pg_constraint")})`,
	`SELECT indrelid FROM pg_index WHERE indexrelid IN (${/* @__PURE__ */ callsOwn("pg_class")})`,
	`SELECT ev_class FROM pg_rewrite WHERE rulename = '_RETURN' AND oid IN (${/* @__PURE__ */ callsOwn("pg_rewrite")})`,
].join(" UNION ")

/* the pairs a flag carries along, as a statement on the second's rows reaches the first's: a view's reads, a parent's children, a referenced table's cascading keys */
const REACHES = /* @__PURE__ */ [
	"SELECT d.refobjid AS a, r.ev_class AS b FROM pg_rewrite r JOIN pg_depend d ON d.classid = 'pg_rewrite'::regclass AND d.objid = r.oid AND d.refclassid = 'pg_class'::regclass WHERE r.rulename = '_RETURN' AND d.refobjid <> r.ev_class",
	"SELECT inhrelid, inhparent FROM pg_inherits",
	"SELECT conrelid, confrelid FROM pg_constraint WHERE contype = 'f' AND (confdeltype IN ('c', 'n', 'd') OR confupdtype IN ('c', 'n', 'd'))",
].join(" UNION ")

/* the user's relations, the system schemas left out */
const USER_REL = "relnamespace NOT IN ('pg_catalog'::regnamespace, 'information_schema'::regnamespace)"

/* one row: the event trigger, the opaque code, the names, the tables and edges, and the LANGUAGE sql definitions */
const SERVER_CODE: string = `SELECT EXISTS (SELECT 1 FROM pg_event_trigger) AS events, (${OPAQUE_CODE}) AS opaque, ARRAY(SELECT DISTINCT proname::text FROM pg_proc WHERE pronamespace NOT IN ('pg_catalog'::regnamespace, 'information_schema'::regnamespace) ORDER BY 1) AS names, ARRAY(SELECT DISTINCT relname::text FROM pg_class WHERE ${USER_REL} AND oid IN (${HOLDS_CODE}) ORDER BY 1) AS tables, COALESCE((SELECT json_agg(json_build_array(x.relname, y.relname) ORDER BY x.relname, y.relname) FROM (${REACHES}) e JOIN pg_class x ON x.oid = e.a JOIN pg_class y ON y.oid = e.b WHERE y.${USER_REL}), '[]'::json) AS reaches, ARRAY(SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang WHERE p.prokind IN ('f', 'p') AND l.lanname = 'sql' AND p.pronamespace NOT IN ('pg_catalog'::regnamespace, 'information_schema'::regnamespace) ORDER BY p.oid) AS sql`

/** The code the database `sql` is connected to holds; a definition Postgres's parser cannot read counts as opaque */
async function serverCode(sql: ReturnType<Connect>): Promise<ServerCode> {
	/* the query's one row */
	const [row] = (await sql.unsafe(SERVER_CODE, [])) as [Record<string, unknown>]
	const reads = (row["sql"] as string[]).map((text) => pgRead(text))
	return {
		events: row["events"] === true,
		names: row["names"] as string[],
		opaque: row["opaque"] === true || reads.some((read) => read.unreadable !== undefined),
		reaches: row["reaches"] as Array<[string, string]>,
		tables: row["tables"] as string[],
		trees: reads.flatMap((read) => read.statements.map((statement) => statement.tree)),
	}
}

/* why comb loads postgres.js in an apply of more than one file */
const READS = "read the code the target holds, which decides how many files one Atlas call may run"

/**
 * The code `target`'s database holds, read once before the apply's calls; a target comb cannot
 * read, or an apply without the postgres package, holds code as far as comb knows, so each file
 * gets a call of its own, as before 0.21
 */
async function targetCode(
	target: PgTarget,
	load: () => Promise<Connect> = () => loadPostgres(READS),
): Promise<ServerCode> {
	try {
		const sql = (await load())({ ...postgresOptionsOf(target.url, "url"), max: 1, onnotice: () => undefined })
		try {
			return await serverCode(sql)
		} finally {
			await sql.end()
		}
	} catch {
		// reason: what comb cannot read it takes for code, which only costs the apply calls
		return UNREAD
	}
}

export { NO_SERVER_CODE, SERVER_CODE, type ServerCode, serverCode, targetCode, UNREAD }
