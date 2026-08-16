/**
 * Diagram Generator — pure transformer from TableMeta[].
 *
 * Generates:
 * - SQLite DDL for ChartDB import
 * - JSON relations for AI consumption
 * - Compact summary for AI context
 */
import * as fs from "node:fs"
import * as path from "node:path"
import type { TableMeta } from "../analyzer-types.ts"
import { writeGenFile, writeGenJsonFile } from "../utils/fs.ts"

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

/** Map Drizzle helper to SQL type */
function drizzleHelperToSqlType(helper: string): string {
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

/** Transform TableMeta[] into diagram structures */
function transformTables(metas: TableMeta[]): { relations: Relation[]; tables: Table[] } {
	const tables: Table[] = []
	const relations: Relation[] = []

	for (const meta of metas) {
		const columns: Column[] = []

		for (const field of meta.fields) {
			const col: Column = {
				name: field.name,
				nullable: !field.isNotNull,
				primaryKey: field.isPrimaryKey,
				type: drizzleHelperToSqlType(field.drizzleHelper),
			}

			if (field.foreignKey) {
				col.reference = {
					column: field.foreignKey.refColumn,
					onDelete: field.foreignKey.onDelete,
					onUpdate: field.foreignKey.onUpdate,
					table: field.foreignKey.refTable,
				}
				relations.push({
					from: `${meta.sqlName}.${field.name}`,
					onDelete: field.foreignKey.onDelete,
					onUpdate: field.foreignKey.onUpdate,
					to: `${field.foreignKey.refTable}.${field.foreignKey.refColumn}`,
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

function generateDDL(tables: Table[], dbName: string): string {
	const lines: string[] = []
	lines.push(`-- ${dbName} Database Schema (SQLite)`)
	lines.push(`-- Tables: ${tables.length}`)
	lines.push("")

	for (const table of tables) {
		lines.push(`CREATE TABLE ${table.name} (`)

		const colDefs: string[] = []
		for (const col of table.columns) {
			let def = `  ${col.name} ${col.type}`
			if (col.primaryKey) def += " PRIMARY KEY"
			if (!col.nullable && !col.primaryKey) def += " NOT NULL"
			if (col.reference) {
				def += ` REFERENCES ${col.reference.table}(${col.reference.column})`
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

const COMMON_COLS = new Set([
	"id",
	"created_at",
	"updated_at",
	"deleted_at",
	"metadata",
	"createdAt",
	"updatedAt",
	"deletedAt",
])

function generateCompactAI(tables: Table[], relations: Relation[]): string {
	const lines: string[] = []
	lines.push(`# ${tables.length} tables, ${relations.length} FKs`)
	lines.push("# [c]=cascade [r]=restrict [n]=set null")
	lines.push("# Columns exclude: id, createdAt, updatedAt, deletedAt, metadata")
	lines.push("")

	const tableIndex = new Map<string, number>()
	for (let i = 0; i < tables.length; i++) {
		const tbl = tables[i]
		if (tbl) tableIndex.set(tbl.name, i + 1)
	}

	lines.push("## Tables & Columns")
	for (let i = 0; i < tables.length; i++) {
		const t = tables[i]
		if (!t) continue
		const cols = t.columns.filter((c) => !COMMON_COLS.has(c.name)).map((c) => c.name)
		const idx = i + 1
		if (cols.length > 0) {
			lines.push(`${idx}. ${t.name}: ${cols.join(", ")}`)
		} else {
			lines.push(`${idx}. ${t.name}: (only common cols)`)
		}
	}
	lines.push("")

	const delSuffix = (d?: string): string => {
		if (!d) return ""
		if (d === "cascade") return "[c]"
		if (d === "restrict") return "[r]"
		if (d === "set null") return "[n]"
		return ""
	}

	lines.push("## FK refs (target <- source.col)")
	const byTargetIdx: Record<number, string[]> = {}
	for (const r of relations) {
		const targetTable = r.to.split(".")[0] ?? ""
		const sourceTable = r.from.split(".")[0] ?? ""
		const sourceCol = r.from.split(".")[1] ?? ""
		const targetIdx = tableIndex.get(targetTable) ?? 0
		const sourceIdx = tableIndex.get(sourceTable) ?? 0
		if (!byTargetIdx[targetIdx]) byTargetIdx[targetIdx] = []
		byTargetIdx[targetIdx]?.push(`${sourceIdx}.${sourceCol}${delSuffix(r.onDelete)}`)
	}

	const sortedTargets = Object.keys(byTargetIdx)
		.map(Number)
		.sort((a, b) => (byTargetIdx[b]?.length ?? 0) - (byTargetIdx[a]?.length ?? 0))
	for (const targetIdx of sortedTargets) {
		const refs = byTargetIdx[targetIdx]
		if (refs) lines.push(`${targetIdx} <- ${refs.join(", ")}`)
	}

	return lines.join("\n")
}

type DiagramsConfig = {
	output: string
}

export function generateDiagrams(
	analysisResult: { dbName: string; tables: TableMeta[] },
	config: DiagramsConfig,
	cwd: string,
): void {
	const outputDir = path.resolve(cwd, config.output)
	const { dbName } = analysisResult

	const { relations, tables } = transformTables(analysisResult.tables)

	if (!fs.existsSync(outputDir)) {
		fs.mkdirSync(outputDir, { recursive: true })
	}

	/* Generate DDL for ChartDB */
	const ddl = generateDDL(tables, dbName)
	const ddlPath = path.join(outputDir, `${dbName}-schema.gen.sql`)
	writeGenFile(ddlPath, ddl, "comb")

	/* Generate relations JSON */
	const jsonData = generateRelationsJSON(tables, relations)
	const jsonPath = path.join(outputDir, `${dbName}-relations.gen.json`)
	writeGenJsonFile(jsonPath, jsonData, "comb")

	/* Generate compact AI summary */
	const compact = generateCompactAI(tables, relations)
	const compactPath = path.join(outputDir, `${dbName}-ai.gen.txt`)
	writeGenFile(compactPath, compact, "comb")

	console.log(`Generated diagrams: ${tables.length} tables, ${relations.length} relations`)
}
