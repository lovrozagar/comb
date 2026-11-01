/**
 * The domains a Postgres history leaves, read from their parse trees (pg-history.ts keeps them):
 * the function a domain's CHECK runs on every column it types (M73), and its default, which fills a
 * column of it added with none of its own (P2 of r18). A domain over a domain takes its base's.
 */
import { builtinFinding } from "./pg-builtins.ts"
import { type Facts, keyOf, names, type Node, nodesOf, typed, typeOf } from "./pg-nodes.ts"

/**
 * The first function an expression calls whose finding is unsafe, by name: code a write runs that
 * comb cannot read. A cautious call such as a default's nextval, which is what a serial does, is
 * no such code (M83).
 */
function callIn(expression: unknown, { defined, schema }: Pick<Facts, "defined" | "schema">): string | undefined {
	for (const [type, node] of nodesOf([expression])) {
		if (type !== "FuncCall") continue
		const name = names(node["funcname"])
		if (builtinFinding(name, { defined, schema })?.level === "unsafe") return keyOf(name, schema)
	}
	return undefined
}

/** A CREATE DOMAIN: what its CHECK runs and its default, either its own or its base domain's */
function followCreate(node: Node, facts: Facts): void {
	const constraints = ((node["constraints"] as Node[] | undefined) ?? []).map((each) => each["Constraint"] as Node)
	const base = typeOf(node["typeName"], facts.schema)
	const domain = keyOf(names(node["domainname"]), facts.schema)
	const runs =
		constraints.map((constraint) => callIn(constraint["raw_expr"], facts)).find((fn) => fn !== undefined) ??
		facts.domains.get(base)
	if (runs !== undefined) facts.domains.set(domain, runs)
	const fill =
		constraints.find((constraint) => constraint["contype"] === "CONSTR_DEFAULT")?.["raw_expr"] ??
		facts.domainDefaults.get(base)
	if (fill !== undefined) facts.domainDefaults.set(domain, fill)
}

/** An ALTER DOMAIN: SET or DROP DEFAULT, or a CHECK added, which runs on every column the domain already types */
function followAlter(node: Node, facts: Facts): void {
	const domain = keyOf(names(node["typeName"]), facts.schema)
	if (node["subtype"] === "T") {
		if (node["def"] === undefined) facts.domainDefaults.delete(domain)
		else facts.domainDefaults.set(domain, node["def"])
		return
	}
	const added = node["subtype"] === "C" ? ((node["def"] as Node)["Constraint"] as Node)["raw_expr"] : undefined
	const runs = callIn(added, facts)
	if (runs === undefined) return
	if (!facts.domains.has(domain)) facts.domains.set(domain, runs)
	for (const [table, types] of facts.columnTypes)
		if (typed(types, domain) && !facts.code.has(table)) facts.code.set(table, runs)
}

/** A domain made or altered, followed into `facts`; whether `type` was one */
function followDomain(type: string, node: Node, facts: Facts): boolean {
	if (type === "CreateDomainStmt") followCreate(node, facts)
	else if (type === "AlterDomainStmt") followAlter(node, facts)
	else return false
	return true
}

export { callIn, followDomain }
