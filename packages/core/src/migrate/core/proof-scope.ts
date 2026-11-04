/**
 * What the D1 proof's copy holds of a shard's schema (8.5 of plan 21, ruled 23:35Z): the live objects pending files
 * can observe, created, and the tables whose rows they can observe, seeded, so the copy refuses what the whole
 * schema would and costs what the files reach.
 *
 * - N: each live object whose name a file spells as a name (sql-code's lexer, compared folded, never as a
 *   substring), and the history table; S is N's tables, which a file creates, alters, drops, renames or writes.
 * - Rows go to S, each table a trigger or view reached from S names (to a fixpoint), D (their FK descendants: a
 *   cascade reaches them) and A (the FK ancestors of all those: their keys must be met).
 * - The copy creates N, the seeded tables, and each view and trigger whose text names an S table (SQLite checks
 *   them on DROP COLUMN and RENAME COLUMN); then to a fixpoint each index and trigger on a created table, each
 *   table and view a created trigger or view names, and each created table's FK ancestors, which a write to it
 *   compiles checks against.
 */
import type { LiveObject } from "./proof-copy.ts"
import { asciiFold, IDENT, sqliteNames } from "./sql-code.ts"

// lookup-table: the shadow tables each module makes beside its virtual table, which creating it makes again
const SHADOWS: Readonly<Record<string, readonly string[]>> = {
	fts3: ["content", "docsize", "segdir", "segments", "stat"],
	fts4: ["content", "docsize", "segdir", "segments", "stat"],
	fts5: ["config", "content", "data", "docsize", "idx"],
	geopoly: ["node", "parent", "rowid"],
	rtree: ["node", "parent", "rowid"],
	rtree_i32: ["node", "parent", "rowid"],
	spellfix1: ["vocab"],
}

const isVirtual = (object: LiveObject): boolean => /^CREATE VIRTUAL TABLE\b/i.test(object.sql)

/** The folded names of the shadow tables virtual table `object`'s module makes */
function shadowsOf(object: LiveObject): string[] {
	/* a CREATE VIRTUAL TABLE names its module */
	const module = (/\bUSING\s+(\w+)/i.exec(object.sql) as RegExpExecArray)[1]?.toLowerCase() as string
	return (SHADOWS[module] ?? []).map((suffix) => asciiFold(`${object.name}_${suffix}`))
}

// per-process-constant: a foreign key's parent, as a column or table constraint names it
const REFERENCES = /* @__PURE__ */ new RegExp(`\\bREFERENCES\\s+(${IDENT})`, "gi")

/** A written name part as SQLite resolves it */
const nameOf = (part: string): string => [...sqliteNames(part)][0] as string

/** What a copy scoped to pending files holds: the live objects it creates, in their order, and the tables it seeds, folded */
type Scope = { objects: LiveObject[]; seeded: Set<string> }

/** `from` and each table `next` leads to from one in it, transitively */
function reach(from: Iterable<string>, next: ReadonlyMap<string, readonly string[]>): Set<string> {
	const out = new Set(from)
	for (const table of out) for (const each of next.get(table) ?? []) out.add(each)
	return out
}

/** `object` added to `into`'s list at `key` */
const add = (into: Map<string, LiveObject[]>, key: string, object: LiveObject) =>
	into.set(key, [...(into.get(key) ?? []), object])

/** The schema `objects` as the closure walks it: by folded name, each table's keys both ways, and each table's indexes and triggers */
function graphOf(objects: readonly LiveObject[]) {
	const names = new Map(objects.map((object) => [object, sqliteNames(object.sql)]))
	const named = new Map<string, LiveObject[]>()
	const on = new Map<string, LiveObject[]>()
	for (const object of objects) {
		add(named, asciiFold(object.name), object)
		if (object.type === "index" || object.type === "trigger") add(on, asciiFold(object.table), object)
		if (isVirtual(object)) for (const shadow of shadowsOf(object)) add(named, shadow, object)
	}
	const tables = new Set(objects.filter((object) => object.type === "table").map((object) => asciiFold(object.name)))
	const parentsOf = new Map<string, string[]>()
	const childrenOf = new Map<string, string[]>()
	for (const object of objects.filter((each) => each.type === "table")) {
		const child = asciiFold(object.name)
		const parents = [...object.sql.matchAll(REFERENCES)]
			.map((match) => nameOf(match[1] as string))
			.filter((parent) => tables.has(parent))
		parentsOf.set(child, parents)
		for (const parent of parents) childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), child])
	}
	return { childrenOf, named, names, on, parentsOf, tables }
}

type Graph = ReturnType<typeof graphOf>

/** `start` and, to a fixpoint, each index and trigger on a table in it, and each table and view a trigger or view in it names */
function forward(graph: Graph, start: Iterable<LiveObject>): Set<LiveObject> {
	const out = new Set(start)
	for (const object of out) {
		if (object.type === "table") for (const each of graph.on.get(asciiFold(object.name)) ?? []) out.add(each)
		if (object.type !== "trigger" && object.type !== "view") continue
		for (const name of graph.names.get(object) as Set<string>)
			for (const each of graph.named.get(name) ?? []) if (each.type === "table" || each.type === "view") out.add(each)
	}
	return out
}

/** The tables of `objects`, folded */
const tablesIn = (objects: Iterable<LiveObject>): Set<string> =>
	new Set([...objects].filter((object) => object.type === "table").map((object) => asciiFold(object.name)))

/** The live objects of `names`, folded */
const objectsOf = (graph: Graph, names: Iterable<string>): LiveObject[] =>
	[...names].flatMap((name) => graph.named.get(name) ?? [])

/**
 * The scope of the copy pending `files` run on over the live schema `objects`, with the binding's history table
 * `history` (see the module's comment)
 */
function observable(objects: readonly LiveObject[], files: ReadonlyArray<{ sql: string }>, history: string): Scope {
	const graph = graphOf(objects)
	const spelled = new Set([asciiFold(history), ...files.flatMap(({ sql }) => [...sqliteNames(sql)])])
	const n = objectsOf(graph, spelled)
	const s = new Set(n.map((object) => asciiFold(object.table)).filter((table) => graph.tables.has(table)))
	/* rows: what a file writes, a trigger it fires writes or a view it reads reads, and what a cascade reaches */
	let written = s
	for (;;) {
		const below = reach(written, graph.childrenOf)
		const next = tablesIn(forward(graph, [...n, ...objectsOf(graph, below)]))
		if ([...next].every((table) => written.has(table))) break
		written = new Set([...written, ...next])
	}
	const seeded = reach(reach(written, graph.childrenOf), graph.parentsOf)
	/* SQLite checks each view and trigger naming a table on DROP COLUMN and RENAME COLUMN of it */
	const checked = objects.filter(
		(object) =>
			(object.type === "view" || object.type === "trigger") &&
			[...(graph.names.get(object) as Set<string>)].some((name) => s.has(name)),
	)
	/* a write to a created table compiles its keys' checks, which need each parent table */
	let made = forward(graph, [...n, ...objectsOf(graph, seeded), ...checked])
	for (;;) {
		const parents = objectsOf(graph, reach(tablesIn(made), graph.parentsOf)).filter((object) => !made.has(object))
		if (parents.length === 0) break
		made = forward(graph, [...made, ...parents])
	}
	return { objects: objects.filter((object) => made.has(object)), seeded }
}

export { isVirtual, observable, type Scope, SHADOWS, shadowsOf }
