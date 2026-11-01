/**
 * What else a Postgres history leaves that Atlas OSS does not compare (P10 of r18): its domains,
 * composite and range types and collations by name, each table's rules and row level security, the
 * extensions it creates, and each sequence's settings. A baseline sets them against the database's
 * catalog (pg-live-objects.ts); a rename, a move or a drop of a table follows in pg-names.ts.
 */
import { type CatalogKind, type Facts, keyOf, names, type Node, type SequenceSettings, tableOf } from "./pg-nodes.ts"

// lookup-table: the ALTER TABLE commands that turn row level security on or off, and which flag
const RLS: Readonly<Record<string, { flag: "enabled" | "forced"; on: boolean }>> = {
	AT_DisableRowSecurity: { flag: "enabled", on: false },
	AT_EnableRowSecurity: { flag: "enabled", on: true },
	AT_ForceRowSecurity: { flag: "forced", on: true },
	AT_NoForceRowSecurity: { flag: "forced", on: false },
}

// lookup-table: the object kinds a DROP or RENAME names that these facts hold, by the parser's object type
const KINDS: Readonly<Record<string, CatalogKind | "type">> = {
	OBJECT_COLLATION: "collation",
	OBJECT_DOMAIN: "domain",
	OBJECT_TYPE: "type",
}

/** A number a DefElem gives: an Integer's, or a Float's digits, as a bigint value spelled out */
function numberOf(arg: unknown): string | undefined {
	const value = arg as { Float?: { fval: string }; Integer?: { ival?: number } } | undefined
	if (value?.Integer !== undefined) return String(value.Integer.ival ?? 0)
	return value?.Float?.fval
}

/** `settings` with what a CREATE SEQUENCE's or ALTER SEQUENCE's options set */
function withOptions(settings: SequenceSettings, options: unknown): SequenceSettings {
	const out = { ...settings }
	for (const each of (options as Node[] | undefined) ?? []) {
		const elem = each["DefElem"] as Node
		const name = String(elem["defname"])
		if (name === "as") out.as = names(((elem["arg"] as Node)["TypeName"] as Node)["names"]).at(-1) as string
		else if (name === "increment") out.increment = numberOf(elem["arg"]) as string
		else if (name === "start") out.start = numberOf(elem["arg"])
		else if (name === "minvalue") out.min = numberOf(elem["arg"])
		else if (name === "maxvalue") out.max = numberOf(elem["arg"])
		else if (name === "cycle")
			out.cycle = ((elem["arg"] as Node | undefined)?.["Boolean"] as Node | undefined)?.["boolval"] === true
	}
	return out
}

const DEFAULTS: SequenceSettings = {
	as: "int8",
	cycle: false,
	increment: "1",
	max: undefined,
	min: undefined,
	start: undefined,
}

/** A sequence made or altered: its settings */
function followSequence(type: string, node: Node, facts: Facts): void {
	const key = tableOf(node["sequence"], facts.schema).key
	if (type === "CreateSeqStmt" && (node["if_not_exists"] !== true || !facts.sequences.has(key)))
		facts.sequences.set(key, withOptions(DEFAULTS, node["options"]))
	const known = facts.sequences.get(key)
	if (type === "AlterSeqStmt" && known !== undefined) facts.sequences.set(key, withOptions(known, node["options"]))
}

/** A type, domain or collation made: its kind, by key */
function followMade(type: string, node: Node, facts: Facts): void {
	if (type === "CreateDomainStmt") facts.kinds.set(keyOf(names(node["domainname"]), facts.schema), "domain")
	else if (type === "CompositeTypeStmt") facts.kinds.set(tableOf(node["typevar"], facts.schema).key, "composite type")
	else if (type === "CreateRangeStmt") facts.kinds.set(keyOf(names(node["typeName"]), facts.schema), "range type")
	else if (type === "DefineStmt" && node["kind"] === "OBJECT_COLLATION")
		facts.kinds.set(keyOf(names(node["defnames"]), facts.schema), "collation")
	else if (type === "CreateExtensionStmt") facts.extensions.add(String(node["extname"]))
	else if (type === "RuleStmt") {
		const table = tableOf(node["relation"], facts.schema).key
		facts.rules.set(table, (facts.rules.get(table) ?? new Set()).add(String(node["rulename"])))
	}
}

/** The parts of the name a DROP's object gives: a type's names, else its list's, else its own string */
function objectNames(object: Node): string[] {
	const named = (object["TypeName"] as Node | undefined)?.["names"] ?? (object["List"] as Node | undefined)?.["items"]
	return named === undefined ? [String((object["String"] as Node)["sval"])] : names(named)
}

/** A type, domain, collation, rule or extension dropped */
function followDropped(node: Node, facts: Facts): void {
	const kind = String(node["removeType"])
	if (KINDS[kind] === undefined && kind !== "OBJECT_EXTENSION" && kind !== "OBJECT_RULE") return
	for (const object of node["objects"] as Node[]) {
		const parts = objectNames(object)
		if (KINDS[kind] !== undefined) facts.kinds.delete(keyOf(parts, facts.schema))
		else if (kind === "OBJECT_EXTENSION") facts.extensions.delete(parts.at(-1) as string)
		else facts.rules.get(keyOf(parts.slice(0, -1), facts.schema))?.delete(parts.at(-1) as string)
	}
}

/** A type, domain, collation or rule renamed */
function followRenamed(node: Node, facts: Facts): void {
	const kind = String(node["renameType"])
	const next = String(node["newname"])
	if (kind === "OBJECT_RULE") {
		const held = facts.rules.get(tableOf(node["relation"], facts.schema).key)
		if (held?.delete(String(node["subname"])) === true) held.add(next)
		return
	}
	if (KINDS[kind] === undefined) return
	const parts = objectNames(node["object"] as Node)
	const was = keyOf(parts, facts.schema)
	const made = facts.kinds.get(was)
	if (made === undefined) return
	facts.kinds.delete(was)
	facts.kinds.set(keyOf([...parts.slice(0, -1), next], facts.schema), made)
}

/** Row level security turned on or off by an ALTER TABLE's commands */
function followRls(node: Node, facts: Facts): void {
	const table = tableOf(node["relation"], facts.schema).key
	for (const each of node["cmds"] as Node[]) {
		const change = RLS[String((each["AlterTableCmd"] as Node)["subtype"])]
		if (change === undefined) continue
		const now = { ...(facts.rls.get(table) ?? { enabled: false, forced: false }), [change.flag]: change.on }
		if (now.enabled || now.forced) facts.rls.set(table, now)
		else facts.rls.delete(table)
	}
}

/** `facts` after a statement on what this module follows */
function followKinds(type: string, node: Node, facts: Facts): void {
	if (type === "CreateSeqStmt" || type === "AlterSeqStmt") followSequence(type, node, facts)
	else if (type === "DropStmt") followDropped(node, facts)
	else if (type === "RenameStmt") followRenamed(node, facts)
	else if (type === "AlterTableStmt") followRls(node, facts)
	else followMade(type, node, facts)
}

/** The bounds of a sequence's type: smallint's, integer's or bigint's */
const BOUNDS: Readonly<Record<string, readonly [bigint, bigint]>> = {
	int2: [-32768n, 32767n],
	int4: [-2147483648n, 2147483647n],
	int8: [-9223372036854775808n, 9223372036854775807n],
}

/** A sequence's settings as the catalog spells them: `start 1, increment 1, min 1, max …, no cycle` */
function sequenceLabel(settings: SequenceSettings): string {
	const [low, high] = BOUNDS[settings.as] ?? (BOUNDS["int8"] as readonly [bigint, bigint])
	const up = BigInt(settings.increment) > 0n
	const min = settings.min ?? String(up ? 1n : low)
	const max = settings.max ?? String(up ? high : -1n)
	const start = settings.start ?? (up ? min : max)
	return `start ${start}, increment ${settings.increment}, min ${min}, max ${max}, ${settings.cycle ? "cycle" : "no cycle"}`
}

export { followKinds, sequenceLabel }
