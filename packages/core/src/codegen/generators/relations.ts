/**
 * Relations Generator — pure transformer from TableMeta[].
 *
 * Generates db.{name}.relations.gen.ts from foreign key references.
 * Builds defineRelations graph from TableMeta FK data.
 */
import path from "node:path"
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

/**
 * Derive r.one relation name from FK column and referenced table.
 *
 * Pattern: if column is exactly `{refTable}_id`, name = camelCase(refTable).
 * If column is `{prefix}_{refTable}_id`, name = camelCase(prefix).
 * Otherwise fall back to stripping `_id` suffix and camelCasing.
 */
function deriveOneName(column: string, refTable: string): string {
	const withoutId = column.replace(/_id$/, "")

	/* exact match: customer_id -> customer */
	if (withoutId === refTable) {
		return toCamelCase(refTable)
	}

	/* prefix match: invited_by_user_id with refTable=user -> invitedBy */
	if (withoutId.endsWith(`_${refTable}`)) {
		const prefix = withoutId.slice(0, -(refTable.length + 1))
		if (prefix.length > 0) {
			return toCamelCase(prefix)
		}
	}

	/* fallback: just camelCase the column without _id */
	return toCamelCase(withoutId)
}

/** Derive r.many relation name: camelCase + pluralize the source table */
function deriveManyName(sourceTable: string): string {
	return pluralize(toCamelCase(sourceTable))
}

type OneRelation = { column: string; name: string; refColumn: string; refTable: string }
/** `targetColumn` is the referenced column on this table, which the many side joins from. */
type ManyRelation = { name: string; sourceColumn: string; sourceTable: string; targetColumn: string }

type Graph = { manys: Map<string, ManyRelation[]>; ones: Map<string, OneRelation[]> }

/** Append to the list under `key`, creating it on first use */
function push<T>(map: Map<string, T[]>, key: string, value: T): void {
	const list = map.get(key)
	if (list) list.push(value)
	else map.set(key, [value])
}

/** r.one on each FK's own table, r.many on the table it references */
function buildGraph(tables: TableMeta[]): Graph {
	const graph: Graph = { manys: new Map(), ones: new Map() }
	for (const table of tables) {
		for (const { foreignKey: fk } of table.fields) {
			if (!fk) continue
			const one = {
				column: fk.column,
				name: deriveOneName(fk.column, fk.refTable),
				refColumn: fk.refColumn,
				refTable: fk.refTable,
			}
			push(graph.ones, table.varName, one)
			const many = {
				name: deriveManyName(table.varName),
				sourceColumn: fk.column,
				sourceTable: table.varName,
				targetColumn: fk.refColumn,
			}
			push(graph.manys, fk.refTable, many)
		}
	}
	for (const manys of graph.manys.values()) disambiguate(manys)
	return graph
}

/** Several r.many of one name on a table: append "By" + the source column without `_id` */
function disambiguate(manys: ManyRelation[]): void {
	const names = manys.map((m) => m.name)
	const repeated = new Set(names.filter((name, i) => names.indexOf(name) !== i))
	for (const m of manys) {
		if (!repeated.has(m.name)) continue
		const suffix = toCamelCase(m.sourceColumn.replace(/_id$/, ""))
		m.name = `${m.name}By${suffix.charAt(0).toUpperCase()}${suffix.slice(1)}`
	}
}

type RelationEntry = { kind: "many"; rel: ManyRelation } | { kind: "one"; rel: OneRelation }

function entryLines(tableName: string, entry: RelationEntry): string[] {
	if (entry.kind === "one") {
		const { column, name, refColumn, refTable } = entry.rel
		return [
			`\t\t${name}: r.one.${refTable}({`,
			`\t\t\tfrom: r.${tableName}.${column},`,
			`\t\t\tto: r.${refTable}.${refColumn},`,
			"\t\t}),",
		]
	}
	const { name, sourceColumn, sourceTable, targetColumn } = entry.rel
	return [
		`\t\t${name}: r.many.${sourceTable}({`,
		`\t\t\tfrom: r.${tableName}.${targetColumn},`,
		`\t\t\tto: r.${sourceTable}.${sourceColumn},`,
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

	/* the tables import follows the actual file name (handles both .gen.ts and .ts) */
	const lines = [
		`import { defineRelations } from "drizzle-orm"`,
		`import * as schema from "./${path.basename(ctx.tablesPath, ".ts")}"`,
		"",
		"export const relations = defineRelations(schema, (r) => ({",
		...sortedTableNames.flatMap((tableName) => tableLines(tableName, graph)),
		"}))",
		"",
	]
	writeGenFile(outputPath, lines.join("\n"), "comb")

	ctx.log(`Generated relations: ${outputPath}`)
	ctx.log(`Tables: ${sortedTableNames.length}, r.one: ${count(graph.ones)}, r.many: ${count(graph.manys)}`)
}
