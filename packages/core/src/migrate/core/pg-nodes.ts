/**
 * A Postgres parse tree as comb reads it (libpg-query 17): its nodes by type, names as the parser
 * lists their parts, and each name keyed as nameKey keys it; and the facts the history's trees
 * leave (pg-history.ts).
 */
import type { TriggerEvent } from "../types.ts"

type Node = Record<string, unknown>

/** What the history attached to its tables, keyed as nameKey keys a Postgres name */
type Facts = {
	/** each type a migration's cast reaches, with the cast's function, and whether the cast is implicit or on assignment */
	casts: Map<string, { automatic: boolean; fn: string }>
	/** why a write to a table runs code: what it runs */
	code: Map<string, string>
	/** each table's column types */
	columnTypes: Map<string, Set<string>>
	/** every function, procedure and aggregate a migration defined, by each key it had */
	defined: Set<string>
	/** each domain whose CHECK calls a function, with the function */
	domains: Map<string, string>
	/** each operator a migration defined, with its function */
	operators: Map<string, string>
	/** each table's parents, and whether it is their partition */
	parents: Map<string, Array<{ parent: string; partition: boolean }>>
	/** the schema an unqualified name resolves in, the one each key leaves out (M72) */
	schema: string
	/** each table's triggers, with the writes that fire them */
	triggers: Map<string, Array<{ events: TriggerEvent[]; name: string }>>
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

export { type Facts, keyOf, names, type Node, nodesOf, tableOf, typeOf }
