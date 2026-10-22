/**
 * Diagram Generator — pure transformer from TableMeta[].
 *
 * Generates:
 * - SQLite DDL for ChartDB import
 * - JSON relations for AI consumption
 * - Compact summary for AI context
 */
import * as path from "node:path"
import type { TableMeta } from "../analyzer-types.ts"
import { sqlIdentifier } from "../utils/case.ts"
import { writeGenFile, writeGenJsonFile } from "../utils/fs.ts"
import type { GeneratorContext } from "./context-types.ts"

interface Column {
	name: string
	nullable: boolean
	primaryKey: boolean
	reference?: {
		column: string
		onDelete?: string | undefined
		onUpdate?: string | undefined
		table: string
	}
	type: string
}

interface Table {
	columns: Column[]
	name: string
}

interface Relation {
	from: string
	onDelete?: string | undefined
	onUpdate?: string | undefined
	to: string
}

/* the Postgres type comb's pg columns create for each helper: epoch timestamps are bigint, json jsonb */
// lookup-table: comb's pg helpers to the types their columns hold
const PG_TYPES: Readonly<Record<string, string>> = {
	blob: "BYTEA",
	boolean: "BOOLEAN",
	createdAt: "BIGINT",
	deletedAt: "BIGINT",
	int: "INTEGER",
	integer: "INTEGER",
	json: "JSONB",
	real: "DOUBLE PRECISION",
	serialId: "SERIAL",
	timestamp: "BIGINT",
	updatedAt: "BIGINT",
}

/** Map a Drizzle helper to its SQL type on the database's engine (F36) */
function drizzleHelperToSqlType(helper: string, dialect: "postgres" | "sqlite"): string {
	if (dialect === "postgres") return Object.hasOwn(PG_TYPES, helper) ? (PG_TYPES[helper] as string) : "TEXT"
	switch (helper) {
		case "integer":
		case "int":
		case "serialId":
		case "timestamp":
		case "createdAt":
		case "updatedAt":
		case "deletedAt":
		case "boolean":
			return "INTEGER"
		case "real":
			return "REAL"
		case "blob":
			return "BLOB"
		default:
			return "TEXT"
	}
}

/**
 * `tables` with each after the tables it references, so the DDL creates every table before a key
 * names it (F36): a table whose references are all placed goes next, in name order; a cycle, which
 * no order satisfies, keeps the rest in name order. A self-reference needs no other table.
 */
function inDependencyOrder(tables: Table[]): Table[] {
	const placed: Table[] = []
	const done = new Set<string>()
	const waiting = [...tables]
	while (waiting.length > 0) {
		const ready = (table: Table) =>
			table.columns.every(
				(col) =>
					col.reference === undefined ||
					col.reference.table === table.name ||
					done.has(col.reference.table) ||
					!tables.some((t) => t.name === col.reference?.table),
			)
		const next = waiting.findIndex(ready)
		const [table] = waiting.splice(next === -1 ? 0 : next, 1) as [Table]
		placed.push(table)
		done.add(table.name)
	}
	return placed
}

/** Transform TableMeta[] into diagram structures */
function transformTables(
	metas: TableMeta[],
	dialect: "postgres" | "sqlite",
): { relations: Relation[]; tables: Table[] } {
	const tables: Table[] = []
	const relations: Relation[] = []
	/* a key names its target by variable and property; SQL and the JSON name it by table and column */
	const byVar = new Map(metas.map((meta) => [meta.varName, meta]))
	const target = (refTable: string, refColumn: string) => {
		const table = byVar.get(refTable)
		const column = table?.fields.find((field) => field.name === refColumn)?.sqlName ?? refColumn
		return { column, table: table?.sqlName ?? refTable }
	}

	for (const meta of metas) {
		const columns: Column[] = []

		for (const field of meta.fields) {
			const col: Column = {
				name: field.sqlName,
				nullable: !field.isNotNull,
				primaryKey: field.isPrimaryKey,
				type: drizzleHelperToSqlType(field.drizzleHelper, dialect),
			}

			if (field.foreignKey) {
				const to = target(field.foreignKey.refTable, field.foreignKey.refColumn)
				col.reference = {
					column: to.column,
					onDelete: field.foreignKey.onDelete,
					onUpdate: field.foreignKey.onUpdate,
					table: to.table,
				}
				relations.push({
					from: `${meta.sqlName}.${field.sqlName}`,
					onDelete: field.foreignKey.onDelete,
					onUpdate: field.foreignKey.onUpdate,
					to: `${to.table}.${to.column}`,
				})
			}

			columns.push(col)
		}

		if (columns.length > 0) {
			tables.push({ columns, name: meta.sqlName })
		}
	}

	return { relations, tables }
}

function generateDDL(tables: Table[], { dbName, dialect }: { dbName: string; dialect: "postgres" | "sqlite" }): string {
	const lines: string[] = []
	lines.push(`-- ${dbName} Database Schema (${dialect === "postgres" ? "Postgres" : "SQLite"})`)
	lines.push(`-- Tables: ${tables.length}`)
	lines.push("")

	for (const table of inDependencyOrder(tables)) {
		lines.push(`CREATE TABLE ${sqlIdentifier(table.name)} (`)

		const colDefs: string[] = []
		for (const col of table.columns) {
			let def = `  ${sqlIdentifier(col.name)} ${col.type}`
			if (col.primaryKey) def += " PRIMARY KEY"
			if (!col.nullable && !col.primaryKey) def += " NOT NULL"
			if (col.reference) {
				def += ` REFERENCES ${sqlIdentifier(col.reference.table)}(${sqlIdentifier(col.reference.column)})`
				if (col.reference.onDelete) def += ` ON DELETE ${col.reference.onDelete.toUpperCase()}`
				if (col.reference.onUpdate) def += ` ON UPDATE ${col.reference.onUpdate.toUpperCase()}`
			}
			colDefs.push(def)
		}

		lines.push(colDefs.join(",\n"))
		lines.push(");")
		lines.push("")
	}

	return lines.join("\n")
}

function generateRelationsJSON(tables: Table[], relations: Relation[]): Record<string, unknown> {
	return {
		relationCount: relations.length,
		relations,
		tableCount: tables.length,
		tables: tables.map((t) => t.name),
	}
}

/** Columns nearly every table carries, left out of the compact summary */
function isCommonColumn(name: string): boolean {
	return ["id", "created_at", "updated_at", "deleted_at", "metadata", "createdAt", "updatedAt", "deletedAt"].includes(
		name,
	)
}

/** The summary's shorthand for a delete rule; rules without one print nothing */
function deleteSuffix(onDelete: string | undefined): string {
	switch (onDelete) {
		case "cascade":
			return "[c]"
		case "restrict":
			return "[r]"
		case "set null":
			return "[n]"
		default:
			return ""
	}
}

function summaryTableLines(tables: Table[]): string[] {
	return tables.map((t, i) => {
		const cols = t.columns.filter((c) => !isCommonColumn(c.name)).map((c) => c.name)
		return `${i + 1}. ${t.name}: ${cols.length > 0 ? cols.join(", ") : "(only common cols)"}`
	})
}

/** One line per referenced table, by 1-based table number (0 when outside the file), most referenced first */
function summaryRefLines(tables: Table[]): string[] {
	const tableIndex = new Map(tables.map((t, i) => [t.name, i + 1]))
	const byTarget = new Map<number, string[]>()
	for (const [i, table] of tables.entries()) {
		for (const { name, reference } of table.columns) {
			if (!reference) continue
			const targetIdx = tableIndex.get(reference.table) ?? 0
			byTarget.set(targetIdx, [
				...(byTarget.get(targetIdx) ?? []),
				`${i + 1}.${name}${deleteSuffix(reference.onDelete)}`,
			])
		}
	}
	return [...byTarget]
		.sort(([a], [b]) => a - b)
		.sort(([, a], [, b]) => b.length - a.length)
		.map(([targetIdx, refs]) => `${targetIdx} <- ${refs.join(", ")}`)
}

function generateCompactAI(tables: Table[], relations: Relation[]): string {
	return [
		`# ${tables.length} tables, ${relations.length} FKs`,
		"# [c]=cascade [r]=restrict [n]=set null",
		"# Columns exclude: id, createdAt, updatedAt, deletedAt, metadata",
		"",
		"## Tables & Columns",
		...summaryTableLines(tables),
		"",
		"## FK refs (target <- source.col)",
		...summaryRefLines(tables),
	].join("\n")
}

type DiagramsConfig = {
	output: string
}

export function generateDiagrams(ctx: GeneratorContext, config: DiagramsConfig): void {
	const { cwd } = ctx
	const outputDir = path.resolve(cwd, config.output)
	const { dbName } = ctx.analysis

	const { relations, tables } = transformTables(ctx.analysis.tables, ctx.dialect)

	/* Generate DDL for ChartDB */
	const ddl = generateDDL(tables, { dbName, dialect: ctx.dialect })
	const ddlPath = path.join(outputDir, `${dbName}-schema.gen.sql`)
	writeGenFile(ddlPath, ddl, { generator: "comb", staged: ctx.staged })

	/* Generate relations JSON */
	const jsonData = generateRelationsJSON(tables, relations)
	const jsonPath = path.join(outputDir, `${dbName}-relations.gen.json`)
	writeGenJsonFile(jsonPath, jsonData, { generator: "comb", staged: ctx.staged })

	/* Generate compact AI summary */
	const compact = generateCompactAI(tables, relations)
	const compactPath = path.join(outputDir, `${dbName}-ai.gen.txt`)
	writeGenFile(compactPath, compact, { generator: "comb", staged: ctx.staged })

	ctx.log(`Generated diagrams: ${tables.length} tables, ${relations.length} relations`)
}
