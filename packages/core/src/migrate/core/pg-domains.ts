/**
 * The domains a Postgres history leaves, read from their parse trees (pg-history.ts keeps them),
 * one record each: its default, which fills a column of it added with none of its own,
 * copied from its base when it has none, as CREATE DOMAIN copies it; and its
 * constraints, by the names Postgres gives them (`d_check`, `d_check1`, `d_not_null`), so ALTER
 * DOMAIN … DROP CONSTRAINT finds them. A CHECK keeps the function it runs on every column the
 * domain types. A base's constraints apply to every domain over it, read through the chain as
 * Postgres does, so one altered later counts too. The record follows the domain's
 * RENAME, SET SCHEMA and DROP, and a constraint's RENAME.
 */
import { builtinFinding } from "./pg-builtins.ts"
import {
	columnTypeOf,
	type ColumnType,
	type Domain,
	type Facts,
	keyOf,
	names,
	type Node,
	nodesOf,
	typeOf,
} from "./pg-nodes.ts"

/**
 * The first function an expression calls whose finding is unsafe, by name: code a write runs that
 * comb cannot read. A cautious call such as a default's nextval, which is what a serial does, is
 * no such code.
 */
function callIn(expression: unknown, { defined, schema }: Pick<Facts, "defined" | "schema">): string | undefined {
	for (const [type, node] of nodesOf([expression])) {
		if (type !== "FuncCall") continue
		const name = names(node["funcname"])
		if (builtinFinding(name, { defined, schema })?.level === "unsafe") return keyOf(name, schema)
	}
	return undefined
}

/** A domain's records from its own up through each base, as Postgres checks a value against them all */
function chainOf(type: string, facts: Facts): Domain[] {
	const chain: Domain[] = []
	for (let at: string | undefined = type; at !== undefined;) {
		const domain = facts.domains.get(at)
		/* a base is a domain made before the one over it, so the chain ends */
		if (domain === undefined) break
		chain.push(domain)
		at = domain.base
	}
	return chain
}

/**
 * What a value of the domain `type` meets on its way into a column, undefined for a type that is no
 * domain: its default; whether any constraint of its chain applies, so Postgres checks every row an
 * added column fills; whether one is a CHECK, or NOT NULL; and the function the first CHECK calls
 */
function domainOf(
	type: string,
	facts: Facts,
):
	| {
			checked: boolean
			constrained: boolean
			fill: unknown
			notNull: boolean
			over: ColumnType
			runs: string | undefined
	  }
	| undefined {
	const chain = chainOf(type, facts)
	if (chain.length === 0) return undefined
	const constraints = chain.flatMap((domain) => [...domain.constraints.values()])
	return {
		checked: constraints.some((constraint) => constraint.kind === "check"),
		constrained: constraints.length > 0,
		fill: (chain[0] as Domain).fill,
		notNull: constraints.some((constraint) => constraint.kind === "notnull"),
		over: (chain[0] as Domain).over,
		runs: constraints.find((constraint) => constraint.runs !== undefined)?.runs,
	}
}

/** The name Postgres gives a constraint of `key`'s domain written with none: `d_check`, then `d_check1`, … */
function nameFor(domain: Domain, key: string, label: "check" | "not_null"): string {
	const stem = `${key.split(".").at(-1) as string}_${label}`
	let name = stem
	for (let n = 1; domain.constraints.has(name); n++) name = `${stem}${n}`
	return name
}

/** A CHECK or NOT NULL constraint of `key`'s domain recorded under its name; the function a CHECK calls */
function constrain(
	{ domain, key }: { domain: Domain; key: string },
	constraint: Node,
	facts: Facts,
): string | undefined {
	const given = constraint["conname"] as string | undefined
	if (constraint["contype"] === "CONSTR_NOTNULL") {
		if (![...domain.constraints.values()].some((each) => each.kind === "notnull"))
			domain.constraints.set(given ?? nameFor(domain, key, "not_null"), { kind: "notnull", runs: undefined })
		return undefined
	}
	if (constraint["contype"] !== "CONSTR_CHECK") return undefined
	const runs = callIn(constraint["raw_expr"], facts)
	domain.constraints.set(given ?? nameFor(domain, key, "check"), { kind: "check", runs })
	return runs
}

/** A CREATE DOMAIN: a record of its own, replacing any a dropped domain of its name left */
function followCreate(node: Node, facts: Facts): void {
	const key = keyOf(names(node["domainname"]), facts.schema)
	const base = typeOf(node["typeName"], facts.schema)
	const over = facts.domains.get(base)
	const constraints = ((node["constraints"] as Node[] | undefined) ?? []).map((each) => each["Constraint"] as Node)
	const own = columnTypeOf(node, facts.schema)
	const domain: Domain = {
		base: over === undefined ? undefined : base,
		constraints: new Map(),
		fill: constraints.find((constraint) => constraint["contype"] === "CONSTR_DEFAULT")?.["raw_expr"] ?? over?.fill,
		/* an array of a domain keeps the domain as its element, as Postgres does */
		over: over === undefined || own.dims > 0 ? own : { ...over.over, collation: own.collation ?? over.over.collation },
	}
	for (const constraint of constraints) constrain({ domain, key }, constraint, facts)
	facts.domains.set(key, domain)
}

/**
 * An ALTER DOMAIN: SET or DROP DEFAULT, SET or DROP NOT NULL, a constraint added or dropped. A CHECK
 * added runs on every column the domain, or one over it, already types.
 */
function followAlter(node: Node, facts: Facts): void {
	const key = keyOf(names(node["typeName"]), facts.schema)
	const domain = facts.domains.get(key)
	if (domain === undefined) return
	const subtype = node["subtype"]
	if (subtype === "T") domain.fill = node["def"]
	else if (subtype === "O") constrain({ domain, key }, { contype: "CONSTR_NOTNULL" }, facts)
	else if (subtype === "N") {
		for (const [name, constraint] of Array.from(domain.constraints))
			if (constraint.kind === "notnull") domain.constraints.delete(name)
	} else if (subtype === "X") domain.constraints.delete(String(node["name"]))
	else if (subtype === "C") {
		const runs = constrain({ domain, key }, (node["def"] as Node)["Constraint"] as Node, facts)
		if (runs === undefined) return
		for (const [table, columns] of facts.columnTypes)
			if (
				[...columns.values()].some((column) => chainOf(column.type, facts).includes(domain)) &&
				!facts.code.has(table)
			)
				facts.code.set(table, runs)
	}
}

/** The domain `from` now `to`: its record, each domain over it, and each column of it */
function moveDomain(facts: Facts, from: string, to: string): void {
	const domain = facts.domains.get(from)
	if (domain === undefined) return
	facts.domains.delete(from)
	facts.domains.set(to, domain)
	for (const each of facts.domains.values()) {
		if (each.base === from) each.base = to
		if (each.over.type === from) each.over = { ...each.over, type: to }
	}
	for (const columns of facts.columnTypes.values())
		for (const [name, column] of columns) if (column.type === from) columns.set(name, { ...column, type: to })
}

/**
 * Every domain key, base and CHECK function `move` maps, and every column's type, as a schema
 * renamed moves what is named under it
 */
function moveDomains(facts: Facts, move: (key: string) => string): void {
	for (const domain of facts.domains.values()) {
		if (domain.base !== undefined) domain.base = move(domain.base)
		domain.over = { ...domain.over, type: move(domain.over.type) }
		for (const constraint of domain.constraints.values())
			if (constraint.runs !== undefined) constraint.runs = move(constraint.runs)
	}
	for (const columns of facts.columnTypes.values())
		for (const [name, column] of columns) columns.set(name, { ...column, type: move(column.type) })
}

/** A domain dropped, and each domain over it, which a CASCADE drops with it and which otherwise stops the drop */
function dropDomain(facts: Facts, key: string): void {
	if (!facts.domains.delete(key)) return
	for (const [other, each] of Array.from(facts.domains)) if (each.base === key) dropDomain(facts, other)
}

/** The name parts of a RenameStmt's or an AlterObjectSchemaStmt's object */
const objectNames = (node: Node): string[] => names(((node["object"] as Node)["List"] as Node)["items"])

// lookup-table: the object kinds a domain is renamed, moved or dropped as (ALTER TYPE and DROP TYPE reach one too)
const DOMAIN_KINDS: ReadonlySet<unknown> = /* @__PURE__ */ new Set(["OBJECT_DOMAIN", "OBJECT_TYPE"])

/** A domain or one of its constraints renamed, a domain moved or dropped, followed into `facts` */
function followDomainName(type: string, node: Node, facts: Facts): void {
	if (type === "RenameStmt" && node["renameType"] === "OBJECT_DOMCONSTRAINT") {
		const domain = facts.domains.get(keyOf(objectNames(node), facts.schema))
		const constraint = domain?.constraints.get(String(node["subname"]))
		if (domain === undefined || constraint === undefined) return
		domain.constraints.delete(String(node["subname"]))
		domain.constraints.set(String(node["newname"]), constraint)
	} else if (type === "RenameStmt" && DOMAIN_KINDS.has(node["renameType"])) {
		const parts = objectNames(node)
		moveDomain(facts, keyOf(parts, facts.schema), keyOf([...parts.slice(0, -1), String(node["newname"])], facts.schema))
	} else if (type === "AlterObjectSchemaStmt" && DOMAIN_KINDS.has(node["objectType"])) {
		const parts = objectNames(node)
		moveDomain(
			facts,
			keyOf(parts, facts.schema),
			keyOf([String(node["newschema"]), parts.at(-1) as string], facts.schema),
		)
	} else if (type === "DropStmt" && DOMAIN_KINDS.has(node["removeType"]))
		for (const object of node["objects"] as Node[])
			dropDomain(facts, keyOf(names((object["TypeName"] as Node)["names"]), facts.schema))
}

/** A domain made or altered, followed into `facts`; whether `type` was one */
function followDomain(type: string, node: Node, facts: Facts): boolean {
	if (type === "CreateDomainStmt") followCreate(node, facts)
	else if (type === "AlterDomainStmt") followAlter(node, facts)
	else return false
	return true
}

export { callIn, domainOf, followDomain, followDomainName, moveDomains }
