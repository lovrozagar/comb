/**
 * An added column read from its type and inline constraints, as the matching ALTER TABLE commands
 * are (P6 of the 0.14.1 review): NOT NULL with nothing to fill it fails on a table with rows, and so
 * does a primary key unless each row gets a value of its own; a volatile default, a serial, an
 * identity or a stored generated column fills every row, which rewrites the table, and an inline
 * check or reference scans it. A default is volatile when it calls a function not known to be
 * otherwise (P8 of the 0.15.0 review): Postgres takes every function as VOLATILE unless it says
 * IMMUTABLE or STABLE, so the rule names the steady ones, not the volatile.
 */
import type { Finding } from "./classify-alter.ts"
import { type Facts, functionBehind, keyOf, names, type Node, nodesOf, typeOf } from "./pg-nodes.ts"

const REWRITES = "rewrites or scans the table under an exclusive lock"

// lookup-table: the built-ins Postgres 17 declares IMMUTABLE or STABLE that a default calls: evaluated once, they rewrite nothing
const STEADY: ReadonlySet<string> = /* @__PURE__ */ new Set([
	"abs",
	"btrim",
	"concat",
	"concat_ws",
	"current_setting",
	"date_part",
	"date_trunc",
	"extract",
	"json_build_array",
	"json_build_object",
	"jsonb_build_array",
	"jsonb_build_object",
	"length",
	"lower",
	"ltrim",
	"make_date",
	"make_interval",
	"make_time",
	"make_timestamp",
	"make_timestamptz",
	"md5",
	"now",
	"replace",
	"round",
	"rtrim",
	"statement_timestamp",
	"to_char",
	"to_json",
	"to_jsonb",
	"transaction_timestamp",
	"upper",
])

// lookup-table: the functions a default computes a value of its own for each row with
const DISTINCT = /* @__PURE__ */ new Set([
	"clock_timestamp",
	"gen_random_uuid",
	"nextval",
	"random",
	"timeofday",
	"uuid_generate_v1",
	"uuid_generate_v1mc",
	"uuid_generate_v4",
])

// lookup-table: the serial types, each a sequence's nextval() as the column's default
const SERIALS = /* @__PURE__ */ new Set(["bigserial", "serial", "serial2", "serial4", "serial8", "smallserial"])

/** The inline constraints of the column an AT_AddColumn command adds */
const inlineConstraints = (cmd: Node): Node[] =>
	((((cmd["def"] as Node)["ColumnDef"] as Node)["constraints"] as Node[] | undefined) ?? []).map(
		(each) => each["Constraint"] as Node,
	)

/** Whether the function `parts` names is known not to be volatile: a steady built-in, or a history routine every overload of which says IMMUTABLE or STABLE */
function steady(parts: readonly string[], facts: Facts): boolean {
	const routine = facts.routines.get(keyOf(parts, facts.schema))
	if (routine !== undefined) return [...routine.signatures.values()].every((volatility) => volatility !== "volatile")
	const builtin = parts.length === 1 || (parts.length === 2 && parts[0] === "pg_catalog")
	return builtin && STEADY.has(parts.at(-1) as string)
}

/**
 * The functions `expr` calls, each by its name's parts: a function call, and the function behind an
 * operator or a cast a migration defined, which Postgres calls as it would the function (P2 of r18)
 */
const callsIn = (expr: unknown, facts: Facts): string[][] =>
	nodesOf(expr).flatMap(([type, node]) => {
		if (type === "FuncCall") return [names(node["funcname"])]
		const behind = functionBehind(type, node, facts)
		return behind === undefined ? [] : [behind.fn.split(".")]
	})

/** The default expressions an added column takes: its own, or with none, its domain's (P2 of r18) */
function defaultsOf(column: Node, constraints: readonly Node[], facts: Facts): unknown[] {
	const own = constraints.filter((each) => each["contype"] === "CONSTR_DEFAULT").map((each) => each["raw_expr"])
	const domain = facts.domainDefaults.get(typeOf(column["typeName"], facts.schema))
	return own.length > 0 || domain === undefined ? own : [domain]
}

/**
 * An added column's findings, from the AT_AddColumn command `cmd`, the functions its default calls
 * read in `facts`; with no default of its own, a column of a domain takes the domain's (P2 of r18)
 */
function addColumn(cmd: Node, _table: string, { facts }: { facts: Facts }): Finding[] {
	const column = (cmd["def"] as Node)["ColumnDef"] as Node
	const constraints = inlineConstraints(cmd)
	const has = (type: string) => constraints.some((each) => each["contype"] === type)
	const defaults = defaultsOf(column, constraints, facts)
	const calls = callsIn(defaults, facts)
	const volatile = calls.some((parts) => DISTINCT.has(parts.at(-1) as string))
	const rewrites = calls.some((parts) => !steady(parts, facts))
	const serial = SERIALS.has(names((column["typeName"] as Node)["names"]).at(-1) as string)
	/* a sequence, an identity or a volatile default gives each row a value of its own */
	const distinct = serial || volatile || has("CONSTR_IDENTITY")
	const filled = distinct || defaults.length > 0 || has("CONSTR_GENERATED")
	const scans = has("CONSTR_CHECK") || has("CONSTR_FOREIGN")
	const findings: Finding[] = []
	if ((has("CONSTR_NOTNULL") && !filled) || (has("CONSTR_PRIMARY") && !distinct)) findings.push({ level: "unsafe" })
	if (distinct || rewrites || has("CONSTR_GENERATED") || scans) findings.push({ level: "lock", note: REWRITES })
	return findings
}

export { addColumn, inlineConstraints, REWRITES }
