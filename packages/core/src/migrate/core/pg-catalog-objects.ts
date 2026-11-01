/**
 * The views, materialized views and sequences a Postgres history leaves, and each table's policies,
 * which a baseline compares against the database by name, as it compares triggers: Atlas OSS
 * inspects none of them (P9 of the 0.15.0 review). A sequence a column owns, a serial's, an
 * identity's or one OWNED BY a column, is its column's, which Atlas compares with the table. A
 * rename, a move or a drop of a relation follows in pg-names.ts.
 */
import { readsOf } from "./pg-cascade.ts"
import { type Facts, keyOf, names, type Node, type Policy, tableOf } from "./pg-nodes.ts"

/** Whether a sequence's options give it to a column: OWNED BY one, not OWNED BY NONE; undefined where they say nothing */
function ownedBy(options: unknown): boolean | undefined {
	const owned = ((options as Node[] | undefined) ?? [])
		.map((each) => each["DefElem"] as Node)
		.find((elem) => elem["defname"] === "owned_by")
	if (owned === undefined) return undefined
	const parts = names(((owned["arg"] as Node)["List"] as Node)["items"])
	return !(parts.length === 1 && parts[0]?.toLowerCase() === "none")
}

// lookup-table: the roles a policy names by keyword, as the history keeps them; a baseline compares CURRENT_USER and its like as the role it connects as (R2 of plan 17)
const ROLE_WORDS: Readonly<Record<string, string>> = {
	ROLESPEC_CURRENT_ROLE: "current_role",
	ROLESPEC_CURRENT_USER: "current_user",
	ROLESPEC_PUBLIC: "public",
	ROLESPEC_SESSION_USER: "session_user",
}

/** A policy's roles: a role by its name, PUBLIC and CURRENT_USER and their like by their keyword */
const rolesOf = (roles: unknown): string[] =>
	(roles as Node[])
		.map((each) => each["RoleSpec"] as Node)
		.map((role) => ROLE_WORDS[String(role["roletype"])] ?? String(role["rolename"]))
		.sort()

/** An ALTER POLICY: its new roles, and what its new USING or WITH CHECK reads, joined to what it read */
function alterPolicy(node: Node, facts: Facts): void {
	const policy = facts.policies.get(tableOf(node["table"], facts.schema).key)?.get(String(node["policy_name"]))
	if (policy === undefined) return
	if (node["roles"] !== undefined) policy.roles = rolesOf(node["roles"])
	const more = readsOf([node["qual"], node["with_check"]], facts.schema)
	for (const key of ["functions", "relations"] as const) for (const each of more[key]) policy.reads[key].add(each)
}

/** A policy renamed, its settings kept */
function renamePolicy(node: Node, facts: Facts): void {
	const held = facts.policies.get(tableOf(node["relation"], facts.schema).key)
	const policy = held?.get(String(node["subname"]))
	if (held === undefined || policy === undefined) return
	held.delete(String(node["subname"]))
	held.set(String(node["newname"]), policy)
}

/** A policy made, altered, renamed or dropped: `facts.policies` after it */
function followPolicy(type: string, node: Node, facts: Facts): void {
	if (type === "CreatePolicyStmt") {
		const table = tableOf(node["table"], facts.schema).key
		const policy: Policy = {
			cmd: String(node["cmd_name"]),
			permissive: node["permissive"] === true,
			reads: readsOf([node["qual"], node["with_check"]], facts.schema),
			roles: rolesOf(node["roles"]),
		}
		facts.policies.set(table, (facts.policies.get(table) ?? new Map()).set(String(node["policy_name"]), policy))
	} else if (type === "AlterPolicyStmt") alterPolicy(node, facts)
	else if (type === "RenameStmt" && node["renameType"] === "OBJECT_POLICY") renamePolicy(node, facts)
	else if (type === "DropStmt" && node["removeType"] === "OBJECT_POLICY") {
		for (const object of node["objects"] as Node[]) {
			const parts = names((object["List"] as Node)["items"])
			facts.policies.get(keyOf(parts.slice(0, -1), facts.schema))?.delete(parts.at(-1) as string)
		}
	}
}

/** `facts.relations` and `facts.policies` after a statement that makes a view, a materialized view, a sequence or a policy, or gives a sequence to a column */
function followCatalogObject(type: string, node: Node, facts: Facts): void {
	if (type === "ViewStmt") facts.relations.set(tableOf(node["view"], facts.schema).key, "view")
	else if (type === "CreateTableAsStmt" && node["objtype"] === "OBJECT_MATVIEW")
		facts.relations.set(tableOf((node["into"] as Node)["rel"], facts.schema).key, "materialized view")
	else if (type === "CreateSeqStmt") {
		const key = tableOf(node["sequence"], facts.schema).key
		if (node["if_not_exists"] !== true || !facts.relations.has(key))
			facts.relations.set(key, ownedBy(node["options"]) === true ? "owned sequence" : "sequence")
	} else if (type === "AlterSeqStmt") {
		const key = tableOf(node["sequence"], facts.schema).key
		const owned = ownedBy(node["options"])
		if (owned !== undefined && facts.relations.has(key)) facts.relations.set(key, owned ? "owned sequence" : "sequence")
	} else followPolicy(type, node, facts)
}

export { followCatalogObject }
