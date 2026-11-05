/**
 * What the D1 proof's copy holds of a shard's schema (8.5 of plan 21, ruled 23:35Z): the live objects pending files
 * can observe, created, and the tables whose rows they can observe, seeded, so the copy refuses what the whole
 * schema would and costs what the files reach.
 *
 * - An object's references are every name its text spells (sql-code's lexer, compared folded, never as a substring)
 *   and, for a virtual table, each string and quoted name among its module's arguments, whole. A table's FK parents
 *   are the other tables it references; a reader is a view, a trigger or a virtual table, and reads what it references.
 * - N: each live object whose name a file spells, and the history table; S is N's tables, which a file creates,
 *   alters, drops, renames or writes.
 * - Rows go to S, each table a reader reached from S references (to a fixpoint), D (their FK descendants: a cascade
 *   reaches them) and A (the FK ancestors of all those: their keys must be met).
 * - The copy creates N, the seeded tables, and each reader that references an S table (SQLite checks views and
 *   triggers on DROP COLUMN and RENAME COLUMN, and a rename rewrites them). Then to a fixpoint each index and trigger
 *   on a created table or view (a view's INSTEAD OF triggers carry out a write through it), each table and view a
 *   created reader references, and each created table's FK ancestors, which a write to it compiles checks against.
 * - Reflection reads the schema itself: a name with SQLite's reserved `sqlite_` prefix (its catalogs, sqlite_sequence,
 *   sqlite_stat*), a `pragma_` table-valued function, or a PRAGMA statement but one that only sets how statements run
 *   (foreign_keys, defer_foreign_keys, legacy_alter_table, recursive_triggers, case_sensitive_like,
 *   ignore_check_constraints, busy_timeout). When a file or an object the copy creates reflects, the copy creates
 *   every object and seeds every table, so SQLite's own tables hold what the whole schema's do.
 * - When a pending file holds an ALTER TABLE, it creates every other view and trigger too, with each table and view
 *   they name through views: SQLite checks the whole schema's on a rename or a dropped column, so one broken anywhere
 *   fails the file, and the copy carries them all rather than a list of which ALTER forms check. The check resolves
 *   names and nothing writes them, so their tables' indexes and FK ancestors stay out. Only the seeded tables get rows.
 */
import type { LiveObject } from "./proof-copy.ts"
import { codeOf, segments } from "../../sql-lexer.ts"
import { asciiFold, pragmaOf, sqliteNames, unquote } from "./sql-code.ts"
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

/* a bare word or one character of punctuation, in code */
const TOKEN = /[A-Za-z_\u0080-\uffff][\w$\u0080-\uffff]*|\S/g

/** A token of SQLite code, by the lexer's kind of segment it came from */
type Token = { kind: string; text: string }

/** `sql`'s tokens as SQLite reads them, comments left out: each word and punctuation of code, each string and quoted name whole */
const tokensOf = (sql: string): Token[] =>
	segments(sql, "sqlite").flatMap<Token>(({ kind, text }) =>
		kind === "comment"
			? []
			: kind === "code"
				? [...text.matchAll(TOKEN)].map(([word]) => ({ kind, text: word }))
				: [{ kind, text }],
	)

/** A token as SQLite resolves it to a name, folded: a string as its whole text, a quoted name unquoted */
const nameOf = ({ kind, text }: Token): string =>
	asciiFold(kind === "literal" ? text.slice(1, -1).replaceAll("''", "'") : unquote(text))

/**
 * Virtual table `object`'s module, the name after USING however it is written, and each string and quoted name among
 * the module's arguments, which the module may read as a table's name (fts5vocab, content=)
 */
function virtualOf(object: LiveObject): { args: string[]; module: string } | undefined {
	if (!isVirtual(object)) return undefined
	const tokens = tokensOf(object.sql)
	const at = tokens.findIndex(({ kind, text }) => kind === "code" && /^using$/i.test(text)) + 1
	const args = tokens[at + 1]?.text === "(" ? tokens.slice(at + 2).filter(({ kind }) => kind !== "code") : []
	return { args: args.map(nameOf), module: nameOf(tokens[at] as Token) }
}

/** The folded names of the shadow tables virtual table `object`'s module makes */
const shadowsOf = (object: LiveObject): string[] =>
	(SHADOWS[virtualOf(object)?.module as string] ?? []).map((suffix) => asciiFold(`${object.name}_${suffix}`))

/** Every name `object` references, folded (see the module's comment) */
const referencesOf = (object: LiveObject): Set<string> =>
	new Set([...sqliteNames(object.sql), ...(virtualOf(object)?.args ?? [])])

/* a name SQLite reserves for its own tables, or a pragma's table-valued function: either reads the schema itself */
const REFLECTION = /^(?:sqlite_|pragma_)/

/** Whether `names` reflect on the schema */
const reflects = (names: Iterable<string>): boolean => [...names].some((name) => REFLECTION.test(name))

// lookup-table: the pragmas that set how statements run and touch no schema object; any other one reads the schema
const QUIET_PRAGMAS: readonly string[] = [
	"busy_timeout",
	"case_sensitive_like",
	"defer_foreign_keys",
	"foreign_keys",
	"ignore_check_constraints",
	"legacy_alter_table",
	"recursive_triggers",
]

/** Whether statement `stmt` is a PRAGMA that reads the schema: any but a quiet one, and one comb cannot read */
function reflectingPragma(stmt: string): boolean {
	const code = codeOf(stmt, "sqlite")
	return /^PRAGMA\b/i.test(code) && !QUIET_PRAGMAS.includes(pragmaOf(code)?.name as string)
}

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
	const names = new Map(objects.map((object) => [object, referencesOf(object)]))
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
		const parents = [...(names.get(object) as Set<string>)].filter((name) => name !== child && tables.has(name))
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

/** Whether `object` is a reader: a view, a trigger or a virtual table, which reads what it references */
const isReader = (object: LiveObject): boolean =>
	object.type === "trigger" || object.type === "view" || isVirtual(object)

/** The tables and views reader `object` references, none for another object */
function namedBy(graph: Graph, object: LiveObject): LiveObject[] {
	if (!isReader(object)) return []
	return objectsOf(graph, graph.names.get(object) as Set<string>).filter(
		(each) => each.type === "table" || each.type === "view",
	)
}

/** `start` and, to a fixpoint, each table and view a reader in it references */
function resolved(graph: Graph, start: Iterable<LiveObject>): Set<LiveObject> {
	const out = new Set(start)
	for (const object of out) for (const each of namedBy(graph, object)) out.add(each)
	return out
}

/** `start` and, to a fixpoint, each index and trigger on a table or view in it, and each table and view a reader in it references */
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
	const checks = objects.filter((object) => object.type === "view" || object.type === "trigger")
	/* a rename rewrites the text of each view and trigger naming an S table, and D1 then compiles the writes to its
	   table; a virtual table reading one reads the rows a file writes */
	const rewritten = objects.filter(
		(object) => isReader(object) && [...(graph.names.get(object) as Set<string>)].some((name) => s.has(name)),
	)
	/* a write to a created table compiles its keys' checks, which need each parent table */
	let made = forward(graph, [...n, ...objectsOf(graph, seeded), ...rewritten])
	for (;;) {
		const parents = objectsOf(graph, reach(tablesIn(made), graph.parentsOf)).filter((object) => !made.has(object))
		if (parents.length === 0) break
		made = forward(graph, [...made, ...parents])
	}
	/* the others an ALTER checks resolve against what they name, which no statement writes */
	const read = statements.some(isAlterTable) ? resolved(graph, checks) : new Set<LiveObject>()
	const kept = objects.filter((object) => made.has(object) || read.has(object))
	/* what reflects on the schema reads every object, and SQLite's own tables, whose rows the whole schema's make */
	if (
		statements.some(reflectingPragma) ||
		reflects(spelled) ||
		kept.some((object) => reflects(graph.names.get(object) as Set<string>))
	)
		return { objects: [...objects], seeded: new Set(graph.tables) }
	return { objects: kept, seeded }
}

export { isVirtual, observable, type Scope, shadowsOf, virtualOf }
