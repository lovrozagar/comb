/**
 * Relations Generator — pure transformer from TableMeta[].
 *
 * Generates db.{name}.relations.gen.ts from foreign key references.
 * Builds defineRelations graph from TableMeta FK data.
 */
import path from "node:path"
import { propertyAccess, propertyName } from "../utils/case.ts"
import { byCodeUnit } from "../utils/order.ts"
import { importPathFrom } from "../utils/paths.ts"
import pluralize from "pluralize"
import type { TableMeta } from "../analyzer-types.ts"
import { writeGenFile } from "../utils/fs.ts"
import type { GeneratorContext } from "./context-types.ts"

type RelationsConfig = {
	output: string
}

/** snake_case to camelCase */
function toCamelCase(s: string): string {
	return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
}

/** `word` with its first letter upper-cased */
const capitalized = (word: string) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`

/** A SQL column without its `_id` / `Id` suffix (only at a word boundary, so `rapid` stays `rapid`), in camelCase */
const roleOf = (sqlColumn: string) => toCamelCase(sqlColumn.replace(/_id$/, "").replace(/([a-z0-9])Id$/, "$1"))

/**
 * A relation's name, read from its own foreign key alone and nothing else of either table: another
 * key added later never renames it (F24). Two keys whose names would collide fail codegen (F7),
 * since any rule that picked one of them to rename would rename an existing relation for the other.
 */
type Named = { name: string; place: string }

/**
 * The r.one name of a foreign key, its role: `customer_id` or `customerId` gives `customer`, and
 * `invited_by_user_id` toward `user` gives `invitedBy`
 */
function oneName(sqlColumn: string, refTable: string): string {
	const whole = roleOf(sqlColumn)
	/* the role is camelCase, so it meets the target's export name camelCased: blog_post as blogPost (F62) */
	const target = toCamelCase(refTable)
	const ref = capitalized(target)
	/* invitedByUser toward user: the prefix names the role */
	return whole !== target && whole.endsWith(ref) && whole.length > ref.length ? whole.slice(0, -ref.length) : whole
}

/**
 * The name of the relation back from a key's target to its source: `posts` when the key is the
 * target's plain `<target>_id`, and `postsBy<Role>`, the role the one side is named by, for every other key. A unique key's way back
 * holds one row, so it is singular (F23).
 */
function backName(source: TableMeta, { plain, role }: { plain: boolean; role: string }, unique: boolean): string {
	const name = toCamelCase(source.varName)
	const count = unique ? pluralize.singular(name) : pluralize(name)
	if (plain) return count
	/* the role the one side is named by, so the two halves of one key agree (F23) */
	return `${count}By${capitalized(role)}`
}

type OneRelation = { columns: string[]; name: string; refColumns: string[]; refTable: string }
/** `targetColumn` is the referenced column on this table, which the other side joins from; `one` for a unique key's way back */
type ManyRelation = {
	name: string
	one: boolean
	sourceColumns: string[]
	sourceTable: string
	targetColumns: string[]
}

type Graph = { manys: Map<string, ManyRelation[]>; ones: Map<string, OneRelation[]> }

/** Append to the list under `key`, creating it on first use */
function push<T>(map: Map<string, T[]>, key: string, value: T): void {
	const list = map.get(key)
	if (list) list.push(value)
	else map.set(key, [value])
}

/** Whether a field's key is unique on its own: `.unique()`, a one-column unique index, or the primary key */
/** Whether `columns`, a key's own, are unique on `table` together: its primary key, a unique column, or a unique set */
function isUnique(table: TableMeta, columns: readonly string[]): boolean {
	const same = (set: readonly string[]) => set.length === columns.length && set.every((name) => columns.includes(name))
	const field = columns.length === 1 ? table.fields.find((each) => each.name === columns[0]) : undefined
	if (field !== undefined && (field.isPrimaryKey || field.unique !== null)) return true
	const key = table.fields.filter((each) => each.inCompositeKey).map((each) => each.name)
	return (key.length > 0 && same(key)) || table.uniqueIndexes.some((index) => same(index.columns))
}

/**
 * Each relation's name on one table; one a column holds, or two relations of one name, fail
 * codegen, naming both
 */
function settle(table: string, named: Array<Named & { target: { name: string } }>, columns: ReadonlySet<string>): void {
	const first = new Map<string, string>()
	for (const each of named) {
		const name = each.name
		/* a relation and a column of one name collide in drizzle; renaming either would change a name
		 * code already uses when the other is added, so the person picks (F22) */
		if (columns.has(name))
			throw new Error(
				`${table}: the relation ${name} of ${each.place} takes the name of the column ${table}.${name}; rename the column, or give the key { relation: "…" }`,
			)
		const other = first.get(name)
		if (other !== undefined)
			throw new Error(
				`${table}: the relations of ${other} and ${each.place} both take the name ${name}; rename one key's column`,
			)
		first.set(name, each.place)
		each.target.name = name
	}
}

/** r.one on each FK's own table, r.many (or r.one, for a unique key) on the table it references */
function buildGraph(tables: TableMeta[]): Graph {
	const graph: Graph = { manys: new Map(), ones: new Map() }
	const named = new Map<string, Array<Named & { target: { name: string } }>>()
	for (const table of tables) {
		for (const field of table.fields) {
			const fk = field.foreignKey
			/* a composite key is one relation, on its first column, joining every column pair (F46) */
			if (!fk || (fk.key !== undefined && fk.key.columns[0] !== fk.column)) continue
			const columns = fk.key?.columns ?? [fk.column]
			const refColumns = fk.key?.refColumns ?? [fk.refColumn]
			const place = `${table.varName}.${fk.column}`
			/* no one column names a composite key's role: it is named for its table, as <table>_id is */
			const sqlColumn = fk.key === undefined ? field.sqlName : `${fk.refTable}_id`
			const one = { columns, name: "", refColumns, refTable: fk.refTable }
			/* a key that names its relation takes that name on both sides; else its column's role (F57) */
			const relation = field.constraints.relation ?? null
			const role = relation ?? oneName(sqlColumn, fk.refTable)
			push(graph.ones, table.varName, one)
			push(named, table.varName, { name: role, place, target: one })
			const unique = isUnique(table, columns)
			const back = {
				name: "",
				one: unique,
				sourceColumns: columns,
				sourceTable: table.varName,
				targetColumns: refColumns,
			}
			push(graph.manys, fk.refTable, back)
			const plain = relation === null && roleOf(sqlColumn) === toCamelCase(fk.refTable)
			push(named, fk.refTable, { name: backName(table, { plain, role }, unique), place, target: back })
		}
	}
	for (const [table, relations] of named) {
		const columns = new Set(
			(tables.find((each) => each.varName === table) as TableMeta).fields.map((field) => field.name),
		)
		settle(table, relations, columns)
	}
	return graph
}

type RelationEntry = { kind: "many"; rel: ManyRelation } | { kind: "one"; rel: OneRelation }

/** `columns` of `table` as a relation names them: one column alone, a composite key's as a list */
const accessOf = (table: string, columns: readonly string[]): string =>
	columns.length === 1
		? propertyAccess(table, columns[0] as string)
		: `[${columns.map((column) => propertyAccess(table, column)).join(", ")}]`

function entryLines(tableName: string, entry: RelationEntry): string[] {
	if (entry.kind === "one") {
		const { columns, name, refColumns, refTable } = entry.rel
		return [
			`\t\t${propertyName(name)}: r.one.${refTable}({`,
			`\t\t\tfrom: ${accessOf(`r.${tableName}`, columns)},`,
			`\t\t\tto: ${accessOf(`r.${refTable}`, refColumns)},`,
			"\t\t}),",
		]
	}
	const { name, one, sourceColumns, sourceTable, targetColumns } = entry.rel
	return [
		`\t\t${propertyName(name)}: r.${one ? "one" : "many"}.${sourceTable}({`,
		`\t\t\tfrom: ${accessOf(`r.${tableName}`, targetColumns)},`,
		`\t\t\tto: ${accessOf(`r.${sourceTable}`, sourceColumns)},`,
		"\t\t}),",
	]
}

/** One table's block, its relations sorted by name; empty when it has none */
function tableLines(tableName: string, graph: Graph): string[] {
	const entries: RelationEntry[] = [
		...(graph.manys.get(tableName) ?? []).map((rel): RelationEntry => ({ kind: "many", rel })),
		...(graph.ones.get(tableName) ?? []).map((rel): RelationEntry => ({ kind: "one", rel })),
	]
	if (entries.length === 0) return []
	entries.sort((a, b) => byCodeUnit(a.rel.name, b.rel.name))
	return [`\t${tableName}: {`, ...entries.flatMap((entry) => entryLines(tableName, entry)), "\t},"]
}

const count = (map: Map<string, unknown[]>) => [...map.values()].reduce((sum, list) => sum + list.length, 0)

/** Build the relations graph and generate code from analyzed tables */
export function generateRelations(ctx: GeneratorContext, config: RelationsConfig): void {
	const { tables } = ctx.analysis
	const outputPath = path.resolve(ctx.cwd, config.output)
	const graph = buildGraph(tables)
	const sortedTableNames = [...new Set(tables.map((t) => t.varName))].sort()

	/* the tables import runs from where the relations file is written to the tables file */
	const tablesImport = importPathFrom(outputPath, path.resolve(ctx.cwd, ctx.tablesPath), ctx.importStyle)
	const body = sortedTableNames.flatMap((tableName) => tableLines(tableName, graph))
	/* with no relation, no r: an unused parameter fails the noUnusedParameters a consumer may set */
	const define =
		body.length === 0
			? ["export const relations = defineRelations(schema, () => ({}))"]
			: ["export const relations = defineRelations(schema, (r) => ({", ...body, "}))"]
	const lines = [
		`import { defineRelations } from "drizzle-orm"`,
		`import * as schema from "${tablesImport}"`,
		"",
		...define,
		"",
	]
	writeGenFile(outputPath, lines.join("\n"), { generator: "comb", staged: ctx.staged })

	ctx.log(`Generated relations: ${outputPath}`)
	ctx.log(`Tables: ${sortedTableNames.length}, r.one: ${count(graph.ones)}, r.many: ${count(graph.manys)}`)
}
