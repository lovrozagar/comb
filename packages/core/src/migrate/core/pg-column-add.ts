/**
 * An added column read from its type and inline constraints, as the matching ALTER TABLE commands
 * are (P6 of the 0.14.1 review): NOT NULL with nothing to fill it fails on a table with rows, and so
 * does a primary key unless each row gets a value of its own; a volatile default, a serial, an
 * identity or a stored generated column fills every row, which rewrites the table, and an inline
 * check or reference scans it. A default is volatile when it calls a function not known to be
 * otherwise (P8 of the 0.15.0 review): Postgres takes every function as VOLATILE unless it says
 * IMMUTABLE or STABLE, so the rule names the steady ones, not the volatile: a history routine by its
 * own declarations, a built-in by Postgres 17's (pg-steady-builtins.ts, read from pg_proc; P15 of r18).
 */
import type { Finding } from "./classify-alter.ts"
import { domainOf } from "./pg-domains.ts"
import { STEADY_BUILTINS } from "./pg-steady-builtins.ts"
import { type Facts, functionBehind, keyOf, names, type Node, nodesOf, typeOf } from "./pg-nodes.ts"

const REWRITES = "rewrites or scans the table under an exclusive lock"

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
	return builtin && STEADY_BUILTINS.has(parts.at(-1) as string)
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

/** The default expressions an added column takes: its own, or with none, its domain's `fill` (P2 of r18) */
function defaultsOf(constraints: readonly Node[], fill: unknown): unknown[] {
	const own = constraints.filter((each) => each["contype"] === "CONSTR_DEFAULT").map((each) => each["raw_expr"])
	return own.length > 0 || fill === undefined ? own : [fill]
}

/**
 * What fills an added column's rows, from its inline `constraints` and its type, read in `facts`:
 * its domain, if it has one; whether a value that fills its rows meets a CHECK of that domain;
 * whether each row gets a value of its own (a sequence, an identity, a
 * volatile default); whether every row gets one; and whether its default calls code Postgres runs
 * per row, which rewrites the table. With no default of its own, a column of a domain takes the
 * domain's (P2 of r18).
 */
function fillOf(column: Node, constraints: readonly Node[], facts: Facts) {
	const has = (type: string) => constraints.some((each) => each["contype"] === type)
	const domain = domainOf(typeOf(column["typeName"], facts.schema), facts)
	const defaults = defaultsOf(constraints, domain?.fill)
	const calls = callsIn(defaults, facts)
	const volatile = calls.some((parts) => DISTINCT.has(parts.at(-1) as string))
	const serial = SERIALS.has(names((column["typeName"] as Node)["names"]).at(-1) as string)
	const distinct = serial || volatile || has("CONSTR_IDENTITY")
	const filled = distinct || defaults.length > 0 || has("CONSTR_GENERATED")
	return {
		/* a value that fills the rows meets a CHECK of the domain on each one */
		checksDefault: domain?.checked === true && filled,
		distinct,
		domain,
		filled,
		rewrites: calls.some((parts) => !steady(parts, facts)),
	}
}

/**
 * An added column's rewrite warning; where a default fills a column of a domain with a CHECK, it also
 * says Postgres checks that default on every row, which comb cannot evaluate and an empty dev database
 * never fails (the reviewer's ruling 1 on 4.1)
 */
function rewriteNote(column: Node, checksDefault: boolean, facts: Facts): string {
	if (!checksDefault) return REWRITES
	const domain = typeOf(column["typeName"], facts.schema)
	return `${REWRITES}; Postgres checks the default against ${domain}'s constraints on every existing row, and fails if any row's value breaks one`
}

/**
 * An added column's findings, from the AT_AddColumn command `cmd`. A domain's NOT NULL is the
 * column's, and with any constraint of the domain's Postgres checks each row, which rewrites the
 * table, default or none (P3 of r19).
 */
function addColumn(cmd: Node, _table: string, { facts }: { facts: Facts }): Finding[] {
	const constraints = inlineConstraints(cmd)
	const has = (type: string) => constraints.some((each) => each["contype"] === type)
	const column = (cmd["def"] as Node)["ColumnDef"] as Node
	const { checksDefault, distinct, domain, filled, rewrites } = fillOf(column, constraints, facts)
	const notNull = has("CONSTR_NOTNULL") || domain?.notNull === true
	const scans = has("CONSTR_CHECK") || has("CONSTR_FOREIGN") || domain?.constrained === true
	const findings: Finding[] = []
	if ((notNull && !filled) || (has("CONSTR_PRIMARY") && !distinct)) findings.push({ level: "unsafe" })
	if (distinct || rewrites || has("CONSTR_GENERATED") || scans)
		findings.push({ level: "lock", note: rewriteNote(column, checksDefault, facts) })
	return findings
}

export { addColumn, inlineConstraints, REWRITES }
