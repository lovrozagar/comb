/**
 * What the D1 proof's copy holds of a shard's schema (8.5 of plan 21, ruled 23:35Z): the live objects pending files
 * can observe, created, and the tables whose rows they can observe, seeded, so the copy refuses what the whole
 * schema would and costs what the files reach.
 *
 * - N: each live object whose name a file spells as a name (sql-code's lexer, compared folded, never as a
 *   substring), and the history table; S is N's tables, which a file creates, alters, drops, renames or writes.
 * - Rows go to S, each table a trigger or view reached from S names (to a fixpoint), D (their FK descendants: a
 *   cascade reaches them) and A (the FK ancestors of all those: their keys must be met).
 * - A file that reads a catalog (sqlite_master, sqlite_schema, their temp forms, pragma_table_list or PRAGMA
 *   table_list) observes every object, so the copy creates them all, seeding only the tables above.
 * - Otherwise the copy creates N, the seeded tables, and each view and trigger whose text names an S table (SQLite checks
 *   them on DROP COLUMN and RENAME COLUMN, and a rename rewrites them). Then to a fixpoint each index and trigger on a
 *   created table or view (a view's INSTEAD OF triggers carry out a write through it), each table and view a created
 *   trigger or view names, and each created table's FK ancestors, which a write to it compiles checks against.
 * - When a pending file holds an ALTER TABLE, it creates every other view and trigger too, with each table and view
 *   they name through views: SQLite checks the whole schema's on a rename or a dropped column, so one broken anywhere
 *   fails the file, and the copy carries them all rather than a list of which ALTER forms check. The check resolves
 *   names and nothing writes them, so their tables' indexes and FK ancestors stay out. Only the seeded tables get rows.
 */
import type { LiveObject } from "./proof-copy.ts"
import { codeOf } from "../../sql-lexer.ts"
import { asciiFold, IDENT, sqliteNames } from "./sql-code.ts"
import { splitSqlStatements } from "./sql-scan.ts"

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

/** Whether SQLite statement `stmt` is an ALTER TABLE, read as code (a comment or a string before it is not) */
const isAlterTable = (stmt: string): boolean => /^ALTER\s+TABLE\b/i.test(codeOf(stmt, "sqlite"))

// lookup-table: the catalogs that list every object of a schema without a statement naming one
const CATALOGS = ["sqlite_master", "sqlite_schema", "sqlite_temp_master", "sqlite_temp_schema", "pragma_table_list"]

/** Whether SQLite statement `stmt` reads a catalog: names one, or is the PRAGMA table_list that reads one */
function readsCatalog(stmt: string): boolean {
	const names = sqliteNames(stmt)
	if (CATALOGS.some((catalog) => names.has(catalog))) return true
	return /^PRAGMA\b/i.test(codeOf(stmt, "sqlite")) && names.has("table_list")
}

/** The folded names of the shadow tables virtual table `object`'s module makes */
function shadowsOf(object: LiveObject): string[] {
	/* a CREATE VIRTUAL TABLE names its module */
	const module = (/\bUSING\s+(\w+)/i.exec(object.sql) as RegExpExecArray)[1]?.toLowerCase() as string
	return (SHADOWS[module] ?? []).map((suffix) => asciiFold(`${object.name}_${suffix}`))
}

// per-process-constant: a foreign key's parent, as a column or table constraint names it
const REFERENCES = /* @__PURE__ */ new RegExp(`\\bREFERENCES\\s+(${IDENT})`, "gi")
// per-process-constant: the table an external-content FTS table reads its rows from, as its content option names it
const CONTENT = /* @__PURE__ */ new RegExp(`\\bcontent\\s*=\\s*('(?:[^']|'')*'|${IDENT})`, "gi")

/** A written name part as SQLite resolves it, a string as its whole text */
const nameOf = (part: string): string =>
	part.startsWith("'") ? asciiFold(part.slice(1, -1).replaceAll("''", "'")) : ([...sqliteNames(part)][0] as string)

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
		/* an FTS table's content table is a parent too: the table's index and every read of it are that table's rows */
		const parents = [...object.sql.matchAll(REFERENCES), ...(isVirtual(object) ? object.sql.matchAll(CONTENT) : [])]
			.map((match) => nameOf(match[1] as string))
			.filter((parent) => tables.has(parent))
		parentsOf.set(child, parents)
		for (const parent of parents) childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), child])
	}
	return { childrenOf, named, names, on, parentsOf, tables }
}

type Graph = ReturnType<typeof graphOf>

/** The tables of `objects`, folded */
const tablesIn = (objects: Iterable<LiveObject>): Set<string> =>
	new Set([...objects].filter((object) => object.type === "table").map((object) => asciiFold(object.name)))

/** The live objects of `names`, folded */
const objectsOf = (graph: Graph, names: Iterable<string>): LiveObject[] =>
	[...names].flatMap((name) => graph.named.get(name) ?? [])

/** The tables and views trigger or view `object` names, none for another object */
function namedBy(graph: Graph, object: LiveObject): LiveObject[] {
	if (object.type !== "trigger" && object.type !== "view") return []
	return objectsOf(graph, graph.names.get(object) as Set<string>).filter(
		(each) => each.type === "table" || each.type === "view",
	)
}

/** `start` and, to a fixpoint, each table and view a trigger or view in it names */
function resolved(graph: Graph, start: Iterable<LiveObject>): Set<LiveObject> {
	const out = new Set(start)
	for (const object of out) for (const each of namedBy(graph, object)) out.add(each)
	return out
}

/** `start` and, to a fixpoint, each index and trigger on a table or view in it, and each table and view a trigger or view in it names */
function forward(graph: Graph, start: Iterable<LiveObject>): Set<LiveObject> {
	const out = new Set(start)
	for (const object of out) {
		/* a view's INSTEAD OF triggers carry out every write through it */
		if (object.type === "table" || object.type === "view")
			for (const each of graph.on.get(asciiFold(object.name)) ?? []) out.add(each)
		for (const each of namedBy(graph, object)) out.add(each)
	}
	return out
}

/**
 * The scope of the copy pending `files` run on over the live schema `objects`, with the binding's history table
 * `history` when the proof writes one, as D1's does (see the module's comment)
 */
function observable(
	objects: readonly LiveObject[],
	files: ReadonlyArray<{ sql: string }>,
	history?: string | undefined,
): Scope {
	const graph = graphOf(objects)
	const spelled = new Set([
		...(history === undefined ? [] : [asciiFold(history)]),
		...files.flatMap(({ sql }) => [...sqliteNames(sql)]),
	])
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
	/* SQLite checks each view and trigger naming a table on DROP COLUMN and RENAME COLUMN of it, and every one of
	   them on an ALTER TABLE that renames or drops a column, wherever it reads */
	const statements = files.flatMap(({ sql }) => splitSqlStatements(sql))
	/* a catalog lists every object, so a file that reads one observes them all, though no more rows */
	if (statements.some(readsCatalog)) return { objects: [...objects], seeded }
	const checks = objects.filter((object) => object.type === "view" || object.type === "trigger")
	/* a rename rewrites the text of each naming an S table, and D1 then compiles the writes to its table */
	const rewritten = checks.filter((object) => [...(graph.names.get(object) as Set<string>)].some((name) => s.has(name)))
	/* a write to a created table compiles its keys' checks, which need each parent table */
	let made = forward(graph, [...n, ...objectsOf(graph, seeded), ...rewritten])
	for (;;) {
		const parents = objectsOf(graph, reach(tablesIn(made), graph.parentsOf)).filter((object) => !made.has(object))
		if (parents.length === 0) break
		made = forward(graph, [...made, ...parents])
	}
	/* the others an ALTER checks resolve against what they name, which no statement writes */
	const read = statements.some(isAlterTable) ? resolved(graph, checks) : new Set<LiveObject>()
	return { objects: objects.filter((object) => made.has(object) || read.has(object)), seeded }
}

export { isVirtual, observable, type Scope, SHADOWS, shadowsOf }
