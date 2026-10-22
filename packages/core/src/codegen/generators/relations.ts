/**
 * Relations Generator — pure transformer from TableMeta[].
 *
 * Generates db.{name}.relations.gen.ts from foreign key references.
 * Builds defineRelations graph from TableMeta FK data.
 */
import path from "node:path"
import { propertyAccess, propertyName } from "../utils/case.ts"
import { importPathFrom } from "../utils/ts-morph.ts"
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
	const ref = capitalized(refTable)
	/* invitedByUser toward user: the prefix names the role */
	return whole !== refTable && whole.endsWith(ref) && whole.length > ref.length ? whole.slice(0, -ref.length) : whole
}

/**
 * The name of the relation back from a key's target to its source: `posts` when the key is the
 * target's plain `<target>_id`, and `postsBy<Column>` for every other key. A unique key's way back
 * holds one row, so it is singular (F23).
 */
function backName(
	source: TableMeta,
	fk: { column: string; refTable: string; sqlColumn: string },
	unique: boolean,
): string {
	const name = toCamelCase(source.varName)
	const count = unique ? pluralize.singular(name) : pluralize(name)
	if (roleOf(fk.sqlColumn) === fk.refTable) return count
	return `${count}By${capitalized(toCamelCase(fk.column.replace(/_id$/, "")))}`
}

type OneRelation = { column: string; name: string; refColumn: string; refTable: string }
/** `targetColumn` is the referenced column on this table, which the other side joins from; `one` for a unique key's way back */
type ManyRelation = { name: string; one: boolean; sourceColumn: string; sourceTable: string; targetColumn: string }

type Graph = { manys: Map<string, ManyRelation[]>; ones: Map<string, OneRelation[]> }

/** Append to the list under `key`, creating it on first use */
function push<T>(map: Map<string, T[]>, key: string, value: T): void {
	const list = map.get(key)
	if (list) list.push(value)
	else map.set(key, [value])
}

/** Whether a field's key is unique on its own: `.unique()`, a one-column unique index, or the primary key */
const isUnique = (table: TableMeta, field: TableMeta["fields"][number]) =>
	field.isPrimaryKey ||
	/\.unique\(/.test(field.raw) ||
	table.uniqueIndexes.some((index) => index.columns.length === 1 && index.columns[0] === field.name)

/**
 * Each relation's name on one table, a name a column holds given `Relation` appended, since a
 * relation and a column of one name collide in drizzle; two relations of one name fail codegen,
 * naming both keys
 */
function settle(table: string, named: Array<Named & { target: { name: string } }>, columns: ReadonlySet<string>): void {
	const first = new Map<string, string>()
	for (const { name, place } of named) {
		const other = first.get(name)
		if (other !== undefined)
			throw new Error(
				`${table}: the relations of ${other} and ${place} both take the name ${name}; rename one key's column`,
			)
		first.set(name, place)
	}
	for (const each of named) each.target.name = columns.has(each.name) ? `${each.name}Relation` : each.name
}

/** r.one on each FK's own table, r.many (or r.one, for a unique key) on the table it references */
function buildGraph(tables: TableMeta[]): Graph {
	const graph: Graph = { manys: new Map(), ones: new Map() }
	const named = new Map<string, Array<Named & { target: { name: string } }>>()
	for (const table of tables) {
		for (const field of table.fields) {
			const fk = field.foreignKey
			if (!fk) continue
			const place = `${table.varName}.${fk.column}`
			const one = { column: fk.column, name: "", refColumn: fk.refColumn, refTable: fk.refTable }
			push(graph.ones, table.varName, one)
			push(named, table.varName, { name: oneName(field.sqlName, fk.refTable), place, target: one })
			const unique = isUnique(table, field)
			const back = {
				name: "",
				one: unique,
				sourceColumn: fk.column,
				sourceTable: table.varName,
				targetColumn: fk.refColumn,
			}
			push(graph.manys, fk.refTable, back)
			const sqlColumn = field.sqlName
			push(named, fk.refTable, { name: backName(table, { ...fk, sqlColumn }, unique), place, target: back })
		}
	}
	for (const [table, relations] of named) {
		const columns = new Set(tables.find((each) => each.varName === table)?.fields.map((field) => field.name) ?? [])
		settle(table, relations, columns)
	}
	return graph
}

type RelationEntry = { kind: "many"; rel: ManyRelation } | { kind: "one"; rel: OneRelation }

function entryLines(tableName: string, entry: RelationEntry): string[] {
	if (entry.kind === "one") {
		const { column, name, refColumn, refTable } = entry.rel
		return [
			`\t\t${propertyName(name)}: r.one.${refTable}({`,
			`\t\t\tfrom: ${propertyAccess(`r.${tableName}`, column)},`,
			`\t\t\tto: ${propertyAccess(`r.${refTable}`, refColumn)},`,
			"\t\t}),",
		]
	}
	const { name, one, sourceColumn, sourceTable, targetColumn } = entry.rel
	return [
		`\t\t${propertyName(name)}: r.${one ? "one" : "many"}.${sourceTable}({`,
		`\t\t\tfrom: ${propertyAccess(`r.${tableName}`, targetColumn)},`,
		`\t\t\tto: ${propertyAccess(`r.${sourceTable}`, sourceColumn)},`,
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
	entries.sort((a, b) => a.rel.name.localeCompare(b.rel.name))
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
	const tablesImport = importPathFrom(outputPath, path.resolve(ctx.cwd, ctx.tablesPath))
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
