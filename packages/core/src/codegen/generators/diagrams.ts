/**
 * Diagram Generator — pure transformer from TableMeta[].
 *
 * Generates:
 * - SQLite DDL for ChartDB import
 * - JSON relations for AI consumption
 * - Compact summary for AI context
 */
import * as path from "node:path"
import type { FieldMeta, TableMeta } from "../analyzer-types.ts"
import { sqlIdentifier } from "../utils/case.ts"
import { writeGenFile, writeGenJsonFile } from "../utils/fs.ts"
import type { GeneratorContext } from "./context-types.ts"
import type { Column, Relation, Table, TableKey } from "./diagram-types.ts"
import { generateCompactAI } from "./diagrams-summary.ts"

/* the Postgres type comb's pg columns create for each helper: epoch timestamps are bigint, json jsonb */
// lookup-table: comb's pg helpers to the types their columns hold
const PG_TYPES: Readonly<Record<string, string>> = {
	boolean: "BOOLEAN",
	createdAt: "BIGINT",
	deletedAt: "BIGINT",
	integer: "INTEGER",
	json: "JSONB",
	real: "DOUBLE PRECISION",
	serialId: "SERIAL",
	timestamp: "BIGINT",
	updatedAt: "BIGINT",
}

/** Map a comb helper to its SQL type on the database's engine (F36) */
function drizzleHelperToSqlType(helper: string, dialect: "postgres" | "sqlite"): string {
	if (dialect === "postgres") return Object.hasOwn(PG_TYPES, helper) ? (PG_TYPES[helper] as string) : "TEXT"
	switch (helper) {
		case "integer":
		case "serialId":
		case "timestamp":
		case "createdAt":
		case "updatedAt":
		case "deletedAt":
		case "boolean":
			return "INTEGER"
		case "real":
			return "REAL"
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
			[
				...table.columns.flatMap((col) => (col.reference ? [col.reference.table] : [])),
				...table.foreignKeys.map((fk) => fk.table),
			].every((to) => to === table.name || done.has(to) || !tables.some((t) => t.name === to))
		const next = waiting.findIndex(ready)
		const [table] = waiting.splice(next === -1 ? 0 : next, 1) as [Table]
		placed.push(table)
		done.add(table.name)
	}
	return placed
}

/* the reader resolves every key to a table of the analysis, and its column to one of that table's */
const sqlNameOf = (table: TableMeta, name: string) =>
	(table.fields.find((field) => field.name === name) as FieldMeta).sqlName

/**
 * What `field`'s foreign key adds to the diagram: a one-column key's REFERENCES on the column, or a
 * composite key's FOREIGN KEY on the table, read at its first column (F46). A key names its target
 * by variable and property; SQL and the JSON name it by table and column.
 */
function keyOf(
	meta: TableMeta,
	field: FieldMeta,
	byVar: ReadonlyMap<string, TableMeta>,
): { reference?: Column["reference"]; relation?: Relation; tableKey?: TableKey } {
	const fk = field.foreignKey
	if (!fk || (fk.key !== undefined && fk.key.columns[0] !== field.name)) return {}
	const { onDelete, onUpdate } = fk
	const to = byVar.get(fk.refTable) as TableMeta
	if (fk.key === undefined) {
		const column = sqlNameOf(to, fk.refColumn)
		return {
			reference: { column, onDelete, onUpdate, table: to.sqlName },
			relation: { from: `${meta.sqlName}.${field.sqlName}`, onDelete, onUpdate, to: `${to.sqlName}.${column}` },
		}
	}
	const columns = fk.key.columns.map((name) => sqlNameOf(meta, name))
	const refColumns = fk.key.refColumns.map((name) => sqlNameOf(to, name))
	return {
		relation: {
			from: `${meta.sqlName}.(${columns.join(", ")})`,
			onDelete,
			onUpdate,
			to: `${to.sqlName}.(${refColumns.join(", ")})`,
		},
		tableKey: { columns, onDelete, onUpdate, refColumns, table: to.sqlName },
	}
}

/** Transform TableMeta[] into diagram structures */
function transformTables(
	metas: TableMeta[],
	dialect: "postgres" | "sqlite",
): { relations: Relation[]; tables: Table[] } {
	const tables: Table[] = []
	const relations: Relation[] = []
	const byVar = new Map(metas.map((meta) => [meta.varName, meta]))

	for (const meta of metas) {
		const columns: Column[] = []
		const foreignKeys: TableKey[] = []

		for (const field of meta.fields) {
			const { reference, relation, tableKey } = keyOf(meta, field, byVar)
			columns.push({
				name: field.sqlName,
				/* a key's column holds no NULL (F33) */
				nullable: !field.isNotNull && !field.inCompositeKey,
				primaryKey: field.isPrimaryKey,
				...(reference && { reference }),
				/* a plain drizzle column is the type drizzle itself writes for it */
				type: field.combKind === null ? field.sqlType.toUpperCase() : drizzleHelperToSqlType(field.combKind, dialect),
			})
			if (relation) relations.push(relation)
			if (tableKey) foreignKeys.push(tableKey)
		}

		if (columns.length > 0) {
			const key = meta.fields.filter((field) => field.inCompositeKey).map((field) => field.sqlName)
			tables.push({ columns, foreignKeys, key, name: meta.sqlName })
		}
	}

	return { relations, tables }
}

/** A key's REFERENCES clause toward `columns` of `table`, with its rules */
function referencesOf(
	table: string,
	columns: readonly string[],
	{ onDelete, onUpdate }: { onDelete?: string | undefined; onUpdate?: string | undefined },
): string {
	let clause = ` REFERENCES ${sqlIdentifier(table)}(${columns.map(sqlIdentifier).join(", ")})`
	if (onDelete) clause += ` ON DELETE ${onDelete.toUpperCase()}`
	if (onUpdate) clause += ` ON UPDATE ${onUpdate.toUpperCase()}`
	return clause
}

function generateDDL(tables: Table[], { dbName, dialect }: { dbName: string; dialect: "postgres" | "sqlite" }): string {
	const lines: string[] = []
	lines.push(`-- ${dbName} Database Schema (${dialect === "postgres" ? "Postgres" : "SQLite"})`)
	lines.push(`-- Tables: ${tables.length}`)
	/* what it renders, so no reader takes it for the database's own DDL (F33) */
	lines.push(
		"-- An outline of the schema: tables, types, keys, NOT NULL and references. Defaults, identity and generated columns are left out; drizzle-kit export writes the full DDL.",
	)
	lines.push("")

	for (const table of inDependencyOrder(tables)) {
		lines.push(`CREATE TABLE ${sqlIdentifier(table.name)} (`)

		const colDefs: string[] = []
		for (const col of table.columns) {
			let def = `  ${sqlIdentifier(col.name)} ${col.type}`
			if (col.primaryKey) def += " PRIMARY KEY"
			if (!col.nullable && !col.primaryKey) def += " NOT NULL"
			if (col.reference) def += referencesOf(col.reference.table, [col.reference.column], col.reference)
			colDefs.push(def)
		}
		if (table.key.length > 0) colDefs.push(`  PRIMARY KEY (${table.key.map(sqlIdentifier).join(", ")})`)
		for (const fk of table.foreignKeys) {
			colDefs.push(
				`  FOREIGN KEY (${fk.columns.map(sqlIdentifier).join(", ")})${referencesOf(fk.table, fk.refColumns, fk)}`,
			)
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
