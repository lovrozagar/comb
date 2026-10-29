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
/** A column's type, keyed as typeOf keys it, and its modifiers, none for one unbounded */
type ColumnType = { mods: readonly number[]; type: string }

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
	/** each operator a migration defined, with its function */
	operators: Map<string, string>
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
	/**
	 * each table's triggers, with the writes that fire them, and `type` as Postgres's tgtype holds
	 * when and for what it fires (row, before, instead of, each event's bit) (P13)
	 */
	triggers: Map<string, Array<{ enabled: boolean; events: TriggerEvent[]; name: string; type: number }>>
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

export {
	type ColumnType,
	type EventTrigger,
	type Facts,
	keyOf,
	modsOf,
	names,
	type Node,
	nodesOf,
	type Routines,
	tableOf,
	typed,
	typeOf,
	type Volatility,
}
