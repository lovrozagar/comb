/**
 * The runtime reader's snapshot as the TableMeta every generator consumes: each column's
 * constraints checked and its facts named as the generators ask for them, each table's unique
 * indexes sorted into plain, partial and expression ones.
 */
import path from "node:path"
import type { CombColumnKind } from "../../meta/column.ts"
import type {
	AnalysisResult,
	FieldMeta,
	ImportRef,
	TableMeta,
	TimestampsMeta,
	UniqueIndexMeta,
} from "../analyzer-types.ts"
import { fieldConstraintsOf } from "../annotations.ts"
import { extractDbName, getTablesImportPath } from "../utils/paths.ts"
import type { ModuleExport, Snapshot, SnapshotColumn, SnapshotTable } from "./snapshot-types.ts"

// lookup-table: timestamp column names under either casing
const TIMESTAMP_KEYS: Record<string, "createdAt" | "deletedAt" | "updatedAt"> = {
	createdAt: "createdAt",
	created_at: "createdAt",
	deletedAt: "deletedAt",
	deleted_at: "deletedAt",
	updatedAt: "updatedAt",
	updated_at: "updatedAt",
}

// lookup-table: the helpers whose values are epoch milliseconds, which the shared timestamp schemas take
const EPOCH_KINDS: ReadonlySet<string> = /* @__PURE__ */ new Set([
	"createdAt",
	"deletedAt",
	"integer",
	"timestamp",
	"updatedAt",
])

// lookup-table: the helpers that fill their own timestamp
const TIMESTAMP_KINDS: ReadonlySet<string> = /* @__PURE__ */ new Set(["createdAt", "deletedAt", "updatedAt"])

/** Whether a column holds epoch milliseconds: a comb timestamp or integer, or a plain integer column */
const isEpoch = (field: FieldMeta) =>
	field.combKind === null ? field.dataType.startsWith("number int") : EPOCH_KINDS.has(field.combKind)

/** The timestamp columns a table declares, each under its own name, and the casing they share */
function detectTimestamps(fields: FieldMeta[]): TimestampsMeta {
	const names: TimestampsMeta["names"] = { createdAt: null, deletedAt: null, updatedAt: null }
	for (const field of fields) {
		const key = Object.hasOwn(TIMESTAMP_KEYS, field.name) ? TIMESTAMP_KEYS[field.name] : undefined
		if (key !== undefined && isEpoch(field)) names[key] = field.name
	}
	const declared = Object.values(names).filter((name) => name !== null)
	const snake = declared.filter((name) => name.includes("_")).length
	const style = snake === 0 ? "camelCase" : snake === declared.length ? "snake_case" : "mixed"
	/* the shared spread takes a column only when its own read schema is the spread's (F10): comb's
	 * helper of that name, read back, NOT NULL but for deletedAt; any other is its own field */
	const spread = (key: keyof TimestampsMeta["names"]) => {
		const field = fields.find((each) => each.name === names[key])
		return field?.combKind === key && !field.constraints.private && field.isNotNull === (key !== "deletedAt")
	}
	return {
		createdAt: spread("createdAt"),
		deletedAt: spread("deletedAt"),
		names,
		style,
		updatedAt: spread("updatedAt"),
	}
}

/** The import a generated file names `at` by: a package by its specifier, a project file by its path */
function importOf(at: ModuleExport): ImportRef {
	if (at.external) return { from: at.module, imported: at.name, name: at.name, path: null }
	return { from: `./${path.basename(at.module, ".ts")}`, imported: at.name, name: at.name, path: at.module }
}

type Build = { file: string; table: SnapshotTable; tables: readonly SnapshotTable[] }

/** A column's key into another table as FieldMeta names it, marked when it points at a c.id key (F10) */
function foreignKeyOf(column: SnapshotColumn, tables: readonly SnapshotTable[]): FieldMeta["foreignKey"] {
	const fk = column.foreignKey
	if (fk === null) return null
	const target = tables.find((each) => each.exportName === fk.table)
	return {
		column: column.key,
		key: fk.key ?? undefined,
		onDelete: fk.onDelete ?? undefined,
		onUpdate: fk.onUpdate ?? undefined,
		refColumn: fk.column,
		refTable: fk.table,
		toId: target?.columns.find((each) => each.key === fk.column)?.comb?.kind === "id",
	}
}

/** Whether something other than the caller fills a timestamp: comb's own helper, or a default or update hook under its name */
const isFilled = (column: SnapshotColumn, kind: string | null) =>
	TIMESTAMP_KINDS.has(kind ?? "") ||
	(Object.hasOwn(TIMESTAMP_KEYS, column.key) && (column.hasDefault || column.onUpdate))

/* what a drizzle column with no comb helper may hold for a DTO to type it: text, numbers, a boolean, JSON */
const TYPABLE = /^(?:string|number|boolean$|object json$)/

/** What a column's `c` helper recorded, as FieldMeta names it; a plain drizzle column's own enum values */
function combFactsOf(
	column: SnapshotColumn,
): Pick<FieldMeta, "enumValues" | "jsonSchemaName" | "prefix" | "schemaImports" | "states"> {
	const comb = column.comb
	const schema = comb?.schema ?? null
	return {
		enumValues: comb?.values ?? column.enumValues,
		jsonSchemaName: schema?.name ?? null,
		prefix: comb?.prefix ?? null,
		schemaImports: schema === null ? [] : [importOf(schema)],
		states: comb?.states ?? null,
	}
}

/** One column as FieldMeta; a constraint comb cannot honour, or a column it cannot type, is an error naming it */
function fieldOf(column: SnapshotColumn, { file, table, tables }: Build): FieldMeta {
	const kind = (column.comb?.kind ?? null) as CombColumnKind | null
	const place = `${file}: ${table.exportName}.${column.key}`
	if (kind === null && !TYPABLE.test(column.dataType))
		throw new Error(
			`${place}: comb has no rule for a ${column.columnType} column (${column.dataType}); build it with a c helper, or as drizzle text, varchar, integer, real, boolean or json`,
		)
	const filled = isFilled(column, kind)
	const constraints = fieldConstraintsOf(column.comb?.constraints ?? {}, { fieldName: column.key, filled, place })
	if (constraints.mutable && column.foreignKey === null && kind !== "ref")
		throw new Error(`${place}: mutable lets a reference move on update, and ${column.key} references nothing`)
	return {
		...combFactsOf(column),
		autoIncrement: column.autoIncrement,
		columnType: column.columnType,
		combKind: kind,
		constraints,
		dataType: column.dataType,
		drizzleHelper: kind ?? column.columnType,
		foreignKey: foreignKeyOf(column, tables),
		generated: column.generated,
		hasDefault: column.hasDefault,
		identity: column.identity,
		inCompositeKey: table.compositeKey.includes(column.key),
		isNotNull: column.notNull,
		isPrimaryKey: column.primary,
		length: typeof constraints.max === "number" ? constraints.max : column.length,
		name: column.key,
		onUpdate: column.onUpdate,
		sqlName: column.sqlName,
		sqlType: column.sqlType,
		unique: column.unique,
	}
}

/** The table's unique indexes: on plain columns, on plain columns under a `.where()`, and on an expression */
function uniquesOf(
	table: SnapshotTable,
): Pick<TableMeta, "expressionIndexes" | "partialUniqueIndexes" | "uniqueIndexes"> {
	const uniqueIndexes: UniqueIndexMeta[] = table.uniques.map(({ columns, name }) => ({ columns, name }))
	const partialUniqueIndexes: UniqueIndexMeta[] = []
	const expressionIndexes: TableMeta["expressionIndexes"] = []
	for (const index of table.indexes.filter((each) => each.unique)) {
		if (index.columns === null) expressionIndexes.push({ expression: index.expression, name: index.name })
		else
			(index.where === null ? uniqueIndexes : partialUniqueIndexes).push({ columns: index.columns, name: index.name })
	}
	return { expressionIndexes, partialUniqueIndexes, uniqueIndexes }
}

function tableOf(build: Build): TableMeta {
	const { table } = build
	const fields = table.columns.map((column) => fieldOf(column, build))
	return {
		...uniquesOf(table),
		checkConstraints: table.checks.map(({ expression, name }) => ({ expression, name })),
		fields,
		hasCompositePrimaryKey: table.compositeKey.length > 0,
		idPrefix: table.columns.find((column) => column.comb?.kind === "id")?.comb?.prefix ?? null,
		schema: table.schema,
		sqlName: table.sqlName,
		timestamps: detectTimestamps(fields),
		varName: table.exportName,
	}
}

/** The analysis generators consume, from the snapshot of `tablesPath`; tables of both engines in one database are refused */
function toAnalysis(snapshot: Snapshot, tablesPath: string): AnalysisResult {
	const dialects = new Set(snapshot.tables.map((table) => table.dialect))
	if (dialects.size > 1)
		throw new Error(
			`${tablesPath}: the database holds both Postgres and SQLite tables; give each engine its own database`,
		)
	const build = (table: SnapshotTable) => tableOf({ file: tablesPath, table, tables: snapshot.tables })
	const tables = snapshot.tables.map(build).sort((a, b) => a.varName.localeCompare(b.varName))
	const schemas = tables.flatMap((table) => table.fields.flatMap((field) => field.schemaImports))
	return {
		dbName: extractDbName(tablesPath),
		dialect: [...dialects][0] ?? null,
		imports: {
			enumImports: new Map(),
			identifiers: new Map(),
			jsonSchemaImports: new Set(schemas.map((ref) => ref.name)),
		},
		tables,
		tablesImportPath: getTablesImportPath(tablesPath),
	}
}

export { toAnalysis }
