/**
 * The locks a Postgres DROP takes, read from a history's facts, and what a DROP … CASCADE drops that
 * no fact shows: CASCADE drops each object that depends on the one dropped, a column's default, a
 * policy's, a CHECK's or a view's expression among them, and locks its table. The history's facts
 * hold no sequence, default or expression's dependencies, so no reading of the file's text names
 * those tables; the map names the object dropped in their place (pg-held.ts), and check on a
 * postgres:// devUrl names what Postgres holds (pg-replay-held.ts). So with what else a statement
 * locks that no fact names: the sequences a dropped table or column owns, the tables made OF a type
 * an ALTER TYPE … CASCADE alters, and everything a DROP or REASSIGN OWNED's roles own.
 */
import { EXCLUSIVE_ALL, keyLocks, type Lock, reachLocks } from "./pg-lock.ts"
import { type Facts, keyOf, names, type Node, tableOf, typed, typeOf } from "./pg-nodes.ts"

/* the relations a move to another schema, a rename, a DROP and an ALTER TABLE's lock take by their own name */
const RELATIONS: RegExp = /^OBJECT_(?:TABLE|VIEW|MATVIEW|FOREIGN_TABLE|SEQUENCE)$/

/** The tables with a column of the type keyed `type` */
const typedTables = (type: string, facts: Facts): string[] =>
	[...facts.columnTypes].filter(([, columns]) => typed(columns, type)).map(([table]) => table)

/** A DROP's objects, each a name's parts */
const dropped = (node: Node): string[][] =>
	(node["objects"] as Array<{ List: Node }>).map((each) => names(each.List["items"]))

/** The locks a DROP of the relation keyed `key` takes: its own, its descendants', a partition's parent's, and through a table's keys */
function relationDrop(key: string, cascade: boolean, facts: Facts): Lock[] {
	const parents = (facts.parents.get(key) ?? []).filter((each) => each.partition)
	return [
		...keyLocks(key, EXCLUSIVE_ALL, facts),
		...parents.map((each): Lock => [each.parent, true]),
		...reachLocks(key, { cascade, kind: "table" }, facts),
	]
}

/** The locks a DROP takes: a relation's, an index's table, a trigger's, policy's or rule's table, and a CASCADE type's tables */
function dropLocks(node: Node, facts: Facts): Lock[] {
	const type = node["removeType"] as string
	if (RELATIONS.test(type))
		return dropped(node).flatMap((parts) =>
			relationDrop(keyOf(parts, facts.schema), node["behavior"] === "DROP_CASCADE", facts),
		)
	if (type === "OBJECT_INDEX")
		return dropped(node).flatMap((parts): Lock[] => {
			const table = facts.indexes.get(keyOf(parts, facts.schema))?.table
			return table === undefined ? [] : [[table, true]]
		})
	if (/^OBJECT_(?:TRIGGER|POLICY|RULE)$/.test(type))
		return dropped(node).map((parts): Lock => [keyOf(parts.slice(0, -1), facts.schema), true])
	if (/^OBJECT_(?:TYPE|DOMAIN)$/.test(type) && node["behavior"] === "DROP_CASCADE")
		return (node["objects"] as Array<{ TypeName: Node }>).flatMap((each) =>
			typedTables(typeOf(each.TypeName, facts.schema), facts).map((table): Lock => [table, true]),
		)
	return []
}

/** One part of a DROP's object a list holds, a name or a type, as the file writes it under `schema` */
const partOf = (part: Node, schema: string): string =>
	"TypeName" in part ? typeOf(part["TypeName"], schema) : String((part["String"] as Node)["sval"])

// lookup-table: how a DROP's object of more than one part reads, by the kind dropped, when not as a qualified name
const LISTED: Readonly<Record<string, (parts: string[], schema: string) => string>> = {
	OBJECT_CAST: ([from, to]) => `(${String(from)} AS ${String(to)})`,
	OBJECT_OPCLASS: ([method, ...name], schema) => `${keyOf(name, schema)} USING ${String(method)}`,
	OBJECT_OPFAMILY: ([method, ...name], schema) => `${keyOf(name, schema)} USING ${String(method)}`,
	OBJECT_POLICY: (parts, schema) => `${String(parts.at(-1))} on ${keyOf(parts.slice(0, -1), schema)}`,
	OBJECT_RULE: (parts, schema) => `${String(parts.at(-1))} on ${keyOf(parts.slice(0, -1), schema)}`,
	OBJECT_TRANSFORM: ([type, language]) => `FOR ${String(type)} LANGUAGE ${String(language)}`,
	OBJECT_TRIGGER: (parts, schema) => `${String(parts.at(-1))} on ${keyOf(parts.slice(0, -1), schema)}`,
}

/** A DROP's object of the kind `type`, as the file names it under `schema` */
function objectOf(type: string, object: Node, schema: string): string {
	if ("String" in object) return String((object["String"] as Node)["sval"])
	if ("TypeName" in object) return typeOf(object["TypeName"], schema)
	if ("ObjectWithArgs" in object) return keyOf(names((object["ObjectWithArgs"] as Node)["objname"]), schema)
	const parts = ((object["List"] as Node)["items"] as Node[]).map((part) => partOf(part, schema))
	return (LISTED[type] ?? ((all: string[]) => keyOf(all, schema)))(parts, schema)
}

/** Each object a DROP … CASCADE drops, as the file names it under `schema`; none for any other DROP */
const cascaded = (node: Node, schema: string): string[] =>
	node["behavior"] === "DROP_CASCADE"
		? (node["objects"] as Node[]).map((object) => objectOf(node["removeType"] as string, object, schema))
		: []

/** The column or constraint an ALTER's DROP … CASCADE command drops, as the file names it; undefined for any other */
function commandCascaded(node: Node, cmd: Node, schema: string): string | undefined {
	if (cmd["behavior"] !== "DROP_CASCADE" || !/^AT_Drop(?:Column|Constraint)$/.test(cmd["subtype"] as string))
		return undefined
	const { key } = tableOf(node["relation"], schema)
	return cmd["subtype"] === "AT_DropConstraint" ? `${String(cmd["name"])} on ${key}` : `${key}.${String(cmd["name"])}`
}

/* the relations whose columns own a sequence, serial, identity or OWNED BY, which their DROP drops */
const OWNING = /^OBJECT_(?:TABLE|FOREIGN_TABLE)$/

/** What a DROP of the relation keyed `key`, or of a column of it, locks that no fact names */
const owned = (key: string): string => `the sequences ${key} owns`

/** What an ALTER TYPE … CASCADE of the type a node's relation names locks that no fact names */
const ofType = (node: Node, schema: string): string => `the tables of type ${tableOf(node["relation"], schema).key}`

/** A role a DROP or REASSIGN OWNED names, as the file writes it: its name, or its keyword */
const roleOf = ({ RoleSpec: role }: { RoleSpec: Node }): string =>
	role["roletype"] === "ROLESPEC_CSTRING" ? String(role["rolename"]) : String(role["roletype"]).slice(9)

/** The facts, and the relations the file made, which no other session sees */
type Seen = { facts: Facts; made: ReadonlySet<string> }

/**
 * What a DROP or REASSIGN OWNED locks, everything its roles own, which no fact names and check's
 * replay leaves out, as it reaches past the database the replay runs in; none for any other statement
 */
const ownedBy = (type: string, node: Node): string[] =>
	type === "DropOwnedStmt" || type === "ReassignOwnedStmt"
		? (node["roles"] as Array<{ RoleSpec: Node }>).map((role) => `everything ${roleOf(role)} owns`)
		: []

/**
 * What a statement other than an ALTER locks that no fact names: a dropped table's sequences, and
 * the tables of a type a RENAME ATTRIBUTE … CASCADE alters; none for any other
 */
function unseen(type: string, node: Node, { facts, made }: Seen): string[] {
	if (type === "RenameStmt")
		return node["renameType"] === "OBJECT_ATTRIBUTE" && node["behavior"] === "DROP_CASCADE"
			? [ofType(node, facts.schema)]
			: []
	if (type !== "DropStmt" || !OWNING.test(node["removeType"] as string)) return []
	return dropped(node)
		.map((parts) => keyOf(parts, facts.schema))
		.filter((key) => !made.has(key))
		.map(owned)
}

/**
 * What an ALTER's command locks that no fact names: the sequences of a dropped column that owns one,
 * or that the history does not show, and the tables of a type an ALTER TYPE … CASCADE alters;
 * undefined for any other
 */
function commandUnseen(node: Node, cmd: Node, { facts, made }: Seen): string | undefined {
	if (node["objtype"] === "OBJECT_TYPE")
		return cmd["behavior"] === "DROP_CASCADE" ? ofType(node, facts.schema) : undefined
	const { key } = tableOf(node["relation"], facts.schema)
	if (cmd["subtype"] !== "AT_DropColumn" || !OWNING.test(node["objtype"] as string) || made.has(key)) return undefined
	const column = facts.columnTypes.get(key)?.get(String(cmd["name"]))
	return column === undefined || column.owns === true ? owned(key) : undefined
}

export { cascaded, commandCascaded, commandUnseen, dropLocks, ownedBy, RELATIONS, typedTables, unseen }
