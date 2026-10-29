/**
 * The event triggers a Postgres history made, and the statements of a later file that fire one
 * (M73): ddl_command_start and ddl_command_end fire on a DDL command whose tag the trigger's
 * `WHEN TAG IN (…)` lists, or on every one when it lists none; sql_drop on a statement that drops
 * something; table_rewrite on a command that rewrites a table. A statement is matched by its
 * command tag, read from its parse tree; a DDL statement whose tag comb does not know matches
 * every trigger, so no new kind of statement escapes one. Shared objects (databases, roles,
 * tablespaces) and event triggers themselves fire none, as Postgres runs none for them.
 */
import type { Finding } from "./classify-alter.ts"
import { ddlFindings, REWRITES } from "./pg-ddl.ts"
import { type EventTrigger, type Facts, names, type Node } from "./pg-nodes.ts"

/** A command whose tag comb does not know: every trigger takes it for its own */
const UNKNOWN = "?"

// lookup-table: an object kind's word in a command tag, where it is not the kind's own name
const WORDS: Readonly<Record<string, string>> = {
	OBJECT_ATTRIBUTE: "TYPE",
	OBJECT_FOREIGN_TABLE: "FOREIGN TABLE",
	OBJECT_MATVIEW: "MATERIALIZED VIEW",
	OBJECT_TABCONSTRAINT: "TABLE",
}

// lookup-table: the tags of the statements a node type is, one per type
const TAGS: Readonly<Record<string, string>> = {
	AlterDomainStmt: "ALTER DOMAIN",
	AlterEnumStmt: "ALTER TYPE",
	AlterExtensionStmt: "ALTER EXTENSION",
	AlterPolicyStmt: "ALTER POLICY",
	AlterSeqStmt: "ALTER SEQUENCE",
	CommentStmt: "COMMENT",
	CompositeTypeStmt: "CREATE TYPE",
	CreateCastStmt: "CREATE CAST",
	CreateDomainStmt: "CREATE DOMAIN",
	CreateEnumStmt: "CREATE TYPE",
	CreateExtensionStmt: "CREATE EXTENSION",
	CreateForeignTableStmt: "CREATE FOREIGN TABLE",
	CreatePolicyStmt: "CREATE POLICY",
	CreateRangeStmt: "CREATE TYPE",
	CreateSchemaStmt: "CREATE SCHEMA",
	CreateSeqStmt: "CREATE SEQUENCE",
	CreateStmt: "CREATE TABLE",
	CreateTrigStmt: "CREATE TRIGGER",
	IndexStmt: "CREATE INDEX",
	RuleStmt: "CREATE RULE",
	SecLabelStmt: "SECURITY LABEL",
	ViewStmt: "CREATE VIEW",
}

// lookup-table: the statements no event trigger runs for: on shared objects, or on event triggers themselves
const NO_EVENT = /* @__PURE__ */ new Set([
	"AlterEventTrigStmt",
	"AlterRoleStmt",
	"AlterTableSpaceOptionsStmt",
	"CreateEventTrigStmt",
	"CreateRoleStmt",
	"CreateTableSpaceStmt",
	"CreatedbStmt",
	"DropRoleStmt",
	"DropTableSpaceStmt",
	"DropdbStmt",
])

/** An object kind's word in a tag: OBJECT_SEQUENCE is SEQUENCE */
const word = (kind: unknown): string =>
	WORDS[String(kind)] ??
	String(kind)
		.replace(/^OBJECT_/, "")
		.replaceAll("_", " ")

// lookup-table: the tags a node type reads from its fields; a SELECT is a command only with INTO
const READ_TAGS: Readonly<Record<string, (node: Node) => string | undefined>> = {
	CreateFunctionStmt: (node) => (node["is_procedure"] === true ? "CREATE PROCEDURE" : "CREATE FUNCTION"),
	CreateTableAsStmt: (node) => (node["objtype"] === "OBJECT_MATVIEW" ? "CREATE MATERIALIZED VIEW" : "CREATE TABLE AS"),
	DefineStmt: (node) => `CREATE ${word(node["kind"])}`,
	GrantStmt: (node) => (node["is_grant"] === true ? "GRANT" : "REVOKE"),
	SelectStmt: (node) => (node["intoClause"] === undefined ? undefined : "SELECT INTO"),
}

/** The command tag a rename, move, ALTER or DROP names by its object */
function objectTag(type: string, node: Node): string | undefined {
	if (type === "AlterTableStmt") return `ALTER ${word(node["objtype"])}`
	if (type === "DropStmt") return `DROP ${word(node["removeType"])}`
	if (type === "RenameStmt") {
		const kind = node["renameType"]
		return `ALTER ${word(kind === "OBJECT_COLUMN" ? node["relationType"] : kind)}`
	}
	if (type === "AlterObjectSchemaStmt" || type === "AlterOwnerStmt") return `ALTER ${word(node["objectType"])}`
	if (type === "AlterFunctionStmt") return `ALTER ${word(node["objtype"])}`
	return undefined
}

/** A top-level statement's command tag; undefined for one no event trigger runs for, UNKNOWN for DDL comb cannot tag */
function tagOf(type: string, node: Node): string | undefined {
	const eventTrigger = node["removeType"] === "OBJECT_EVENT_TRIGGER" || node["renameType"] === "OBJECT_EVENT_TRIGGER"
	if (NO_EVENT.has(type) || eventTrigger) return undefined
	const known = TAGS[type] ?? objectTag(type, node)
	if (known !== undefined) return known
	const read = READ_TAGS[type]
	if (read !== undefined) return read(node)
	/* a CREATE, ALTER or DROP of a kind this module has not named is DDL all the same */
	return /^(?:Create|Alter|Drop)/.test(type) ? UNKNOWN : undefined
}

/** Whether a top-level statement drops an object, as sql_drop takes one */
function drops(type: string, node: Node): boolean {
	if (type === "DropStmt") return node["removeType"] !== "OBJECT_EVENT_TRIGGER"
	if (type === "DropOwnedStmt") return true
	if (type === "AlterDomainStmt") return node["subtype"] === "X"
	if (type !== "AlterTableStmt") return false
	return (node["cmds"] as Node[]).some((each) =>
		/^AT_Drop(?:Column|Constraint)$/.test(String((each["AlterTableCmd"] as Node)["subtype"])),
	)
}

/** Whether a top-level statement rewrites a table, as table_rewrite takes one: a command M70 warns of */
const rewrites = (type: string, node: Node, facts: Facts): boolean =>
	(ddlFindings(type, node, facts) ?? []).some((finding) => finding.level === "lock" && finding.note === REWRITES)

type Firing = { everyTrigger: boolean; facts: Facts }

/** Whether `trigger`, as the history left it, fires on the top-level statement `type` */
function fires(trigger: EventTrigger, [type, node]: [string, Node], { everyTrigger, facts }: Firing): boolean {
	if (!trigger.enabled && !everyTrigger) return false
	if (trigger.event === "sql_drop") return drops(type, node)
	if (trigger.event === "table_rewrite") return rewrites(type, node, facts)
	const tag = tagOf(type, node)
	if (tag === undefined) return false
	return trigger.tags === undefined || tag === UNKNOWN || trigger.tags.includes(tag)
}

/**
 * The event triggers the top-level statements of a parse tree fire, every one whatever its state
 * once the file set session_replication_role: each unsafe, as its function is code comb does not read
 */
function eventFindings(
	stmts: unknown,
	{ everyTrigger, facts }: { everyTrigger?: boolean | undefined; facts: Facts },
): Finding[] {
	const tops = (stmts as Array<{ stmt: Node }>).map(({ stmt }) => Object.entries(stmt)[0] as [string, Node])
	return [...facts.eventTriggers].flatMap(([name, trigger]) =>
		tops.some((top) => fires(trigger, top, { everyTrigger: everyTrigger === true, facts }))
			? [{ level: "unsafe" as const, note: `runs event trigger ${name}, whose function comb does not read` }]
			: [],
	)
}

/** An event trigger made, altered, renamed or dropped: `facts` after it; whether `type` was one */
function followEventTrigger(type: string, node: Node, facts: Facts): boolean {
	if (type === "CreateEventTrigStmt") {
		const when = ((node["whenclause"] as Node[] | undefined) ?? []).map((each) => each["DefElem"] as Node)
		const tags = when.find((elem) => elem["defname"] === "tag")
		facts.eventTriggers.set(String(node["trigname"]), {
			enabled: true,
			event: String(node["eventname"]),
			tags:
				tags === undefined
					? undefined
					: names(((tags["arg"] as Node)["List"] as Node)["items"]).map((tag) => tag.toUpperCase()),
		})
	} else if (type === "AlterEventTrigStmt") {
		const trigger = facts.eventTriggers.get(String(node["trigname"]))
		/* ENABLE REPLICA fires only under session_replication_role = replica, which no migration runs with */
		if (trigger !== undefined) trigger.enabled = node["tgenabled"] === "O" || node["tgenabled"] === "A"
	} else if (type === "RenameStmt" && node["renameType"] === "OBJECT_EVENT_TRIGGER") {
		const was = String(((node["object"] as Node)["String"] as Node)["sval"])
		const trigger = facts.eventTriggers.get(was)
		facts.eventTriggers.delete(was)
		if (trigger !== undefined) facts.eventTriggers.set(String(node["newname"]), trigger)
	} else if (type === "DropStmt" && node["removeType"] === "OBJECT_EVENT_TRIGGER") {
		for (const object of node["objects"] as Node[])
			facts.eventTriggers.delete(String((object["String"] as Node)["sval"]))
	} else return false
	return true
}

export { eventFindings, followEventTrigger, tagOf }
