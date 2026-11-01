/**
 * A Postgres parse tree as comb reads it (libpg-query 17): its nodes by type, names as the parser
 * lists their parts, and each name keyed as nameKey keys it; and the facts the history's trees
 * leave (pg-history.ts).
 */
import type { TriggerEvent } from "../types.ts"

type Node = Record<string, unknown>

/** An event trigger the history made: the event it runs on, its `WHEN TAG IN` list, and whether it is enabled (M73) */
type EventTrigger = { enabled: boolean; event: string; tags: string[] | undefined }

/** The functions and procedures a history leaves: each key's kind and its signatures, the input argument types */
/** What a relation that is no table is: a sequence a column owns is the column's, which no baseline compares on its own */
type Relation = "materialized view" | "owned sequence" | "sequence" | "view"

/**
 * What a view's query or a policy's expressions read: the relations and functions they name, by key,
 * and the column names they read, `all` for a `*` (P4 of r18)
 */
type Reads = { columns: Set<string> | "all"; functions: Set<string>; relations: Set<string> }

/** A policy: its command, its roles (`public` for PUBLIC), whether it is permissive, and what it reads (P10 of r18) */
type Policy = { cmd: string; permissive: boolean; reads: Reads; roles: string[] }

/** A sequence's settings as its CREATE and ALTERs give them, each left out where Postgres defaults it (P10 of r18) */
type SequenceSettings = {
	as: string
	cycle: boolean
	increment: string
	max: string | undefined
	min: string | undefined
	start: string | undefined
}

/** The kinds of object a baseline compares by name in the target schema, which Atlas OSS does not (P10 of r18) */
type CatalogKind = "collation" | "composite type" | "domain" | "range type"

/** The facts of a history with nothing in it, its names keyed under `schema` */
const emptyFacts = (schema: string): Facts => ({
	casts: new Map(),
	code: new Map(),
	columnTypes: new Map(),
	defined: new Set(),
	defaultPartitions: new Map(),
	extensions: new Set(),
	kinds: new Map(),
	domainDefaults: new Map(),
	domains: new Map(),
	eventTriggers: new Map(),
	operators: new Map(),
	parents: new Map(),
	policies: new Map(),
	reads: new Map(),
	rls: new Map(),
	rules: new Map(),
	sequences: new Map(),
	relations: new Map(),
	routines: new Map(),
	schema,
	tables: new Map(),
	triggers: new Map(),
	views: new Map(),
})

/**
 * A column's type, keyed as typeOf keys it: its modifiers, none for one unbounded, its array
 * dimensions, 0 for a scalar (`int[]` and `int ARRAY` have 1), and its collation, undefined for its
 * type's default
 */
type ColumnType = { collation: string | undefined; dims: number; mods: readonly number[]; type: string }

/** Whether a column of `columns` has the type `type` */
const typed = (columns: ReadonlyMap<string, ColumnType>, type: string): boolean =>
	[...columns.values()].some((column) => column.type === type)

/** A type name's modifiers, the integers it is written with: varchar(20) has [20], numeric(12, 2) [12, 2] */
const modsOf = (typeName: unknown): number[] =>
	(((typeName as Node)["typmods"] as Node[] | undefined) ?? []).map((mod) =>
		Number(
			(((mod["A_Const"] as Node | undefined)?.["ival"] as Node | undefined)?.["ival"] as number | undefined) ??
				Number.NaN,
		),
	)

/** A routine's volatility, as its CREATE or an ALTER FUNCTION declares it */
type Volatility = "immutable" | "stable" | "volatile"

/** Each routine by key: its kind, and its signatures, each with its volatility */
type Routines = Map<string, { kind: "function" | "procedure"; signatures: Map<string, Volatility> }>

/** What the history attached to its tables, keyed as nameKey keys a Postgres name */
type Facts = {
	/** each type a migration's cast reaches, with the cast's function, and whether the cast is implicit or on assignment */
	casts: Map<string, { automatic: boolean; fn: string }>
	/** why a write to a table runs code: what it runs */
	code: Map<string, string>
	/** each table's columns, each with its type and the type's modifiers, as varchar(20) has [20] (P12 of the 0.15.0 review) */
	columnTypes: Map<string, Map<string, ColumnType>>
	/** each event trigger the history made, by name */
	eventTriggers: Map<string, EventTrigger>
	/** every function, procedure and aggregate a migration defined, by each key it had */
	defined: Set<string>
	/** the functions and procedures the history leaves, by key, with their signatures (pg-routines.ts) */
	routines: Routines
	/** each domain whose CHECK calls a function, with the function */
	domains: Map<string, string>
	/** each domain with a default, its own or its base domain's, with the default's expression (P2 of r18) */
	domainDefaults: Map<string, unknown>
	/** each operator a migration defined, with its function */
	operators: Map<string, string>
	/** each partitioned table's DEFAULT partition, which a new partition's bound is checked against (P12 of r18) */
	defaultPartitions: Map<string, string>
	/** each table's parents, and whether it is their partition */
	parents: Map<string, Array<{ parent: string; partition: boolean }>>
	/** the schema an unqualified name resolves in, the one each key leaves out (M72) */
	schema: string
	/** each table the history's trees made, with its columns (M70) */
	tables: Map<string, Set<string>>
	/**
	 * each view, with the one table or view its query reads, undefined when it reads no single one
	 * (a join, a set operation), and how its columns name the base's, `all` for `*` (M71)
	 */
	views: Map<string, { base: string | undefined; columns: Map<string, string> | "all" }>
	/** the views, materialized views and sequences the history leaves, by key, a column's own sequence marked so (P9) */
	relations: Map<string, Relation>
	/** each table's policies, by name, with their settings and what they read (P9, P10 of r18) */
	policies: Map<string, Map<string, Policy>>
	/**
	 * each table's triggers, with the writes that fire them, and `type` as Postgres's tgtype holds
	 * when and for what it fires (row, before, instead of, each event's bit) (P13)
	 */
	triggers: Map<string, Array<{ enabled: boolean; events: TriggerEvent[]; fn: string; name: string; type: number }>>
	/** what each view and materialized view reads, by its key, for a CASCADE drop to follow (P4 of r18) */
	reads: Map<string, Reads>
	/** each extension the history creates, by name (P10 of r18) */
	extensions: Set<string>
	/** each domain, composite and range type and collation, by key, with its kind (P10 of r18) */
	kinds: Map<string, CatalogKind>
	/** each table's row level security, enabled and forced, where either is on (P10 of r18) */
	rls: Map<string, { enabled: boolean; forced: boolean }>
	/** each table's rules, by name (P10 of r18) */
	rules: Map<string, Set<string>>
	/** each sequence's settings, by key (P10 of r18) */
	sequences: Map<string, SequenceSettings>
}

/** Every node under `node`, by its type, the type's fields with it */
function nodesOf(node: unknown, out: Array<[string, Node]> = []): Array<[string, Node]> {
	if (Array.isArray(node)) for (const each of node) nodesOf(each, out)
	else if (node !== null && typeof node === "object") {
		for (const [key, value] of Object.entries(node)) {
			if (value !== null && typeof value === "object" && !Array.isArray(value) && /^[A-Z]/.test(key))
				out.push([key, value as Node])
			nodesOf(value, out)
		}
	}
	return out
}

/* the parts of a name, as the parser lists them: each a String node */
const names = (list: unknown): string[] => (list as Array<{ String: { sval: string } }>).map((part) => part.String.sval)

/**
 * A name's key, as nameKey keys a Postgres name under `schema`, the one an unqualified name resolves
 * in: pg_catalog and `schema` left out, so `users` and `<schema>.users` are one key (M72)
 */
const keyOf = (parts: readonly string[], schema: string): string =>
	parts.filter((part, i) => (i < parts.length - 1 ? part !== "pg_catalog" && part !== schema : true)).join(".")

/** A RangeVar's table under `schema`: its bare name, its key, and whether it is temporary */
function tableOf(relation: unknown, schema: string): { key: string; name: string; temp: boolean } {
	const rel = relation as { relname: string; relpersistence: string; schemaname?: string }
	const key = keyOf(rel.schemaname === undefined ? [rel.relname] : [rel.schemaname, rel.relname], schema)
	return { key, name: rel.relname, temp: rel.relpersistence === "t" || rel.schemaname === "pg_temp" }
}

/** A type's key under `schema` */
const typeOf = (typeName: unknown, schema: string): string => keyOf(names((typeName as Node)["names"]), schema)

/**
 * The migration's function an expression node runs on its way: an operator a migration defined, a
 * bare one resolved through the search path to a migration's in any schema, or a cast to a type a
 * migration's cast reaches; undefined for any other node
 */
function functionBehind(
	type: string,
	node: Node,
	facts: Facts,
): { fn: string; kind: "cast" | "operator"; name: string } | undefined {
	if (type === "A_Expr" && Array.isArray(node["name"])) {
		const operator = keyOf(names(node["name"]), facts.schema)
		const fn =
			facts.operators.get(operator) ??
			(operator.includes(".")
				? undefined
				: [...facts.operators].find(([key]) => key.split(".").at(-1) === operator)?.[1])
		return fn === undefined ? undefined : { fn, kind: "operator", name: operator }
	}
	if (type !== "TypeCast") return undefined
	const target = typeOf(node["typeName"], facts.schema)
	const cast = facts.casts.get(target)
	return cast === undefined ? undefined : { fn: cast.fn, kind: "cast", name: target }
}

/**
 * A column definition's type under `schema`, as a CREATE TABLE, an ADD COLUMN or an ALTER COLUMN …
 * TYPE leaves it: a definition that names no collation, or `default`, takes its type's default
 */
function columnTypeOf(def: Node, schema: string): ColumnType {
	const typeName = def["typeName"] as Node
	const clause = def["collClause"] as Node | undefined
	const collation = clause === undefined ? undefined : keyOf(names(clause["collname"]), schema)
	return {
		collation: collation === "default" ? undefined : collation,
		dims: ((typeName["arrayBounds"] as unknown[] | undefined) ?? []).length,
		mods: modsOf(typeName),
		type: typeOf(typeName, schema),
	}
}

export {
	type CatalogKind,
	columnTypeOf,
	type ColumnType,
	emptyFacts,
	type EventTrigger,
	type Facts,
	functionBehind,
	keyOf,
	modsOf,
	names,
	type Node,
	nodesOf,
	type Policy,
	type Reads,
	type Relation,
	type Routines,
	type SequenceSettings,
	tableOf,
	typed,
	typeOf,
	type Volatility,
}
