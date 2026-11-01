/**
 * Which of comb's Postgres views and policies a migration must drop and create again (pg-objects.ts):
 * those whose definition changed or went, and those that read a table Atlas alters, since Postgres
 * refuses to retype a column a view or policy reads, with every view over a view that goes.
 */
import type { PgObject } from "./pg-objects.ts"
import { readsOf } from "./pg-cascade.ts"
import type { Node } from "./pg-nodes.ts"
import { parsePostgres } from "./pg-parser.ts"
import { lastPart } from "./sql-code.ts"
import { normalizeSql } from "./sql-scan.ts"

/**
 * The relations a view's or materialized view's query, or a policy's USING and WITH CHECK, read, by
 * their bare names, from its parse tree, as a CASCADE drop reads them (pg-cascade.ts, R1 of plan 17)
 */
function relationsOf(object: PgObject): Set<string> {
	const [stmt] = (parsePostgres(object.sql) as { stmts: Array<{ stmt: Node }> }).stmts
	const [type, node] = Object.entries((stmt as { stmt: Node }).stmt)[0] as [string, Node]
	const read = type === "CreatePolicyStmt" ? [node["qual"], node["with_check"]] : node["query"]
	return new Set([...readsOf(read, "").relations].map((key) => key.slice(key.lastIndexOf(".") + 1)))
}

/** Whether a view's definition, or a policy's USING or WITH CHECK, reads the relation `name` */
const reads = (object: PgObject, name: string): boolean => relationsOf(object).has(name)

const isView = (object: PgObject): boolean => object.kind === "view" || object.kind === "materialized view"
/** Whether two objects are defined alike, layout and comments aside */
const same = (a: PgObject | undefined, b: PgObject | undefined): boolean =>
	a !== undefined && b !== undefined && normalizeSql(a.sql) === normalizeSql(b.sql)

/** The views and policies of `from` comb must drop: changed, removed, or over what Atlas or comb changes */
function affected(from: Map<string, PgObject>, to: Map<string, PgObject>, tables: ReadonlySet<string>): Set<string> {
	const out = new Set<string>()
	for (const [key, object] of from) {
		if (!isView(object) && object.kind !== "policy") continue
		if (!same(object, to.get(key))) out.add(key)
		if (object.kind === "policy" && tables.has(lastPart(object.on as string))) out.add(key)
		const read = relationsOf(object)
		if ([...tables].some((table) => read.has(table))) out.add(key)
	}
	return withDependentViews(from, out)
}

/** `out` with each view over a view in it added, until no more join: a view comb drops takes them along */
function withDependentViews(from: Map<string, PgObject>, out: Set<string>): Set<string> {
	let grew = true
	while (grew) {
		grew = false
		for (const [key, object] of from) {
			const over = [...out].some(
				(other) => isView(from.get(other) as PgObject) && reads(object, (from.get(other) as PgObject).key),
			)
			if (isView(object) && !out.has(key) && over) {
				out.add(key)
				grew = true
			}
		}
	}
	return out
}

export { affected, isView, reads, same }
