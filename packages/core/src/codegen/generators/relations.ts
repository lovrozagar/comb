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

/**
 * The r.one name of a foreign key, read from its SQL column: `customer_id` or `customerId` gives
 * `customer`, `invited_by_user_id` toward `user` gives `invitedBy`. `Id` is stripped only at a word
 * boundary, so `rapid` stays `rapid`. A name one of the table's columns holds gets `Relation`
 * appended, since a relation and a column of one name collide in drizzle.
 */
function deriveOneName(sqlColumn: string, refTable: string, columns: ReadonlySet<string>): string {
	const base = toCamelCase(sqlColumn.replace(/_id$/, "").replace(/([a-z0-9])Id$/, "$1"))
	const ref = `${refTable.charAt(0).toUpperCase()}${refTable.slice(1)}`
	/* invitedByUser toward user: the prefix names the role */
	const name = base !== refTable && base.endsWith(ref) && base.length > ref.length ? base.slice(0, -ref.length) : base
	return columns.has(name) ? `${name}Relation` : name
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
		const columns = new Set(table.fields.map((field) => field.name))
		for (const { foreignKey: fk, sqlName } of table.fields) {
			if (!fk) continue
			const one = {
				column: fk.column,
				name: deriveOneName(sqlName, fk.refTable, columns),
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
	for (const [target, manys] of graph.manys) {
		disambiguate(manys)
		/* a many name its table already uses, for a column or a one relation, takes the suffix the one side takes (F7) */
		const taken = new Set([
			...(tables.find((table) => table.varName === target)?.fields.map((field) => field.name) ?? []),
			...(graph.ones.get(target) ?? []).map((one) => one.name),
		])
		for (const many of manys) if (taken.has(many.name)) many.name = `${many.name}Relation`
	}
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
			`\t\t${propertyName(name)}: r.one.${refTable}({`,
			`\t\t\tfrom: ${propertyAccess(`r.${tableName}`, column)},`,
			`\t\t\tto: ${propertyAccess(`r.${refTable}`, refColumn)},`,
			"\t\t}),",
		]
	}
	const { name, sourceColumn, sourceTable, targetColumn } = entry.rel
	return [
		`\t\t${propertyName(name)}: r.many.${sourceTable}({`,
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
