/**
 * Constraint map generator — pure transformer from TableMeta[].
 *
 * Generates constraint maps from analyzed table metadata for database error handling.
 */
import path from "node:path"
import { toScreamingSnakeCase } from "../utils/case.ts"
import type { TableMeta } from "../analyzer-types.ts"
import { writeGenFile } from "../utils/fs.ts"
import type { GeneratorContext } from "./context-types.ts"

type Constraint = {
	cause: string
	errorKey: string
	statusKey: string
}

type TableConstraints = {
	check?: Record<string, Constraint>
	foreignKey?: Record<string, Constraint>
	primaryKey?: Constraint
	unique?: Record<string, Constraint>
}

type ConstraintMap = Record<string, TableConstraints>

type ConstraintsConfig = {
	output: string
}

const conflict = (cause: string, errorKey: string): Constraint => ({ cause, errorKey, statusKey: "conflict" })

/** The column-level and index-level unique constraints, keyed by the column's SQL name */
function uniqueOf(table: TableMeta): Record<string, Constraint> | undefined {
	const unique: Record<string, Constraint> = {}
	for (const field of table.fields.filter((f) => /\.unique\(\)/.test(f.raw))) {
		unique[field.sqlName] = conflict(
			`A record with this ${field.name} value already exists`,
			`${table.sqlName}_${field.name}_duplicate`,
		)
	}
	/* a partial index fails with the same "UNIQUE constraint failed: <table>.<column>" as a full one */
	for (const col of [...table.uniqueIndexes, ...table.partialUniqueIndexes].flatMap((idx) => idx.columns)) {
		/* the engine reports the column's SQL name; the error key keeps the property name */
		const sqlName = table.fields.find((f) => f.name === col)?.sqlName ?? col
		unique[sqlName] = conflict(`A record with this ${col} value already exists`, `${table.sqlName}_${col}_duplicate`)
	}
	return Object.keys(unique).length > 0 ? unique : undefined
}

/** The cause and status a CHECK reports, read from its name's convention */
function checkVerdict(name: string, expression: string): Omit<Constraint, "errorKey"> {
	if (name.endsWith("_enum")) return { cause: "Invalid enum value", statusKey: "bad_request" }
	if (name.includes("_size")) {
		const bytes = expression.match(/<=\s*(\d+)/)?.[1]
		if (bytes === undefined) return { cause: "Check constraint violated", statusKey: "conflict" }
		return {
			cause: `Exceeds maximum size of ${Math.round(Number.parseInt(bytes, 10) / 1024)}KB`,
			statusKey: "bad_request",
		}
	}
	if (name.includes("expiry") || name.includes("valid")) {
		return { cause: "Invalid date/time constraint", statusKey: "bad_request" }
	}
	if (name.includes("integrity")) return { cause: "Data integrity constraint violated", statusKey: "conflict" }
	return { cause: "Check constraint violated", statusKey: "conflict" }
}

function constraintsOf(table: TableMeta): TableConstraints {
	const entry: TableConstraints = {}
	if (table.fields.some((f) => f.isPrimaryKey) || table.hasCompositePrimaryKey) {
		entry.primaryKey = conflict("Record with this ID already exists", `${table.sqlName}_id_duplicate`)
	}
	const fkFields = table.fields.filter((f) => f.foreignKey !== null)
	if (fkFields.length > 0) {
		entry.foreignKey = Object.fromEntries(
			fkFields.map((field) => [
				field.sqlName,
				conflict("Referenced record does not exist", `${table.sqlName}_${field.name}_reference_not_found`),
			]),
		)
	}
	const unique = uniqueOf(table)
	if (unique) entry.unique = unique
	if (table.checkConstraints.length > 0) {
		entry.check = Object.fromEntries(
			table.checkConstraints.map((chk) => [
				chk.name,
				{ ...checkVerdict(chk.name, chk.expression), errorKey: `${table.sqlName}_${chk.name}_failed` },
			]),
		)
	}
	return entry
}

/** The constraint map of every table that has a constraint, keyed by SQL table name */
export function buildConstraintMap(tables: readonly TableMeta[]): ConstraintMap {
	const map: ConstraintMap = {}
	for (const table of tables) {
		const entry = constraintsOf(table)
		if (Object.keys(entry).length > 0) map[table.sqlName] = entry
	}
	return map
}

/** Every constraint in the map, flattened */
export function constraintsIn(map: ConstraintMap): Constraint[] {
	return Object.values(map).flatMap(({ check, foreignKey, primaryKey, unique }) => [
		...(primaryKey ? [primaryKey] : []),
		...[check, foreignKey, unique].flatMap((group) => Object.values(group ?? {})),
	])
}

function countConstraints(map: ConstraintMap): number {
	let total = 0
	for (const { check, foreignKey, primaryKey, unique } of Object.values(map)) {
		if (primaryKey) total++
		for (const group of [check, foreignKey, unique]) total += Object.keys(group ?? {}).length
	}
	return total
}

/** Generate constraint map from analyzed tables */
export function generateConstraints(ctx: GeneratorContext, config: ConstraintsConfig): void {
	const { dbName, tables } = ctx.analysis
	const outputPath = path.resolve(ctx.cwd, config.output)
	const constraintMap = buildConstraintMap(tables)

	writeGenFile(outputPath, generateConstraintMapCode(constraintMap, dbName), "comb")

	ctx.log(`Generated constraint map for ${dbName} database at: ${outputPath}`)
	ctx.log(`Tables: ${Object.keys(constraintMap).length}, Total constraints: ${countConstraints(constraintMap)}`)
}

/** Entries in the order a plain `.sort()` puts their keys */
const byKey = ([a]: [string, unknown], [b]: [string, unknown]): number => (a < b ? -1 : 1)

const GROUP_LABELS: Record<string, string> = {
	check: "check constraints",
	foreignKey: "foreign key constraints",
	unique: "unique constraints",
}

/** The lines of one `{ errorKey, cause, statusKey }` object at `indent` */
function constraintLines(constraint: Constraint, indent: string): string[] {
	return [
		`${indent}errorKey: "${constraint.errorKey}",`,
		`${indent}cause: "${constraint.cause}",`,
		`${indent}statusKey: "${constraint.statusKey}",`,
	]
}

/** Entries joined the way the generated map writes them: a comma after every closing brace but the last */
function joined(blocks: string[][]): string[] {
	return blocks.flatMap((block, i) => (i < blocks.length - 1 ? [...block.slice(0, -1), `${block.at(-1)},`] : block))
}

function groupLines(type: string, group: Constraint | Record<string, Constraint>): string[] {
	if (type === "primaryKey") {
		return [
			"\t\t/* primary key constraint */",
			"\t\tprimaryKey: {",
			...constraintLines(group as Constraint, "\t\t\t"),
			"\t\t}",
		]
	}
	const columns = Object.entries(group as Record<string, Constraint>).sort(byKey)
	const blocks = columns.map(([column, constraint]) => [
		`\t\t\t${column}: {`,
		...constraintLines(constraint, "\t\t\t\t"),
		"\t\t\t}",
	])
	return [`\t\t/* ${GROUP_LABELS[type]} */`, `\t\t${type}: {`, ...joined(blocks), "\t\t}"]
}

/** Generate TypeScript constraint map code */
function generateConstraintMapCode(map: ConstraintMap, dbName: string): string {
	const tables = Object.entries(map).sort(byKey)
	const blocks = tables.map(([tableName, constraints]) => {
		const groups = Object.entries(constraints).sort(byKey)
		return [
			`\t/* ${tableName} table constraints */`,
			`\t${tableName}: {`,
			...joined(groups.map(([type, group]) => groupLines(type, group as Constraint | Record<string, Constraint>))),
			"\t}",
		]
	})
	return [
		`export const ${toScreamingSnakeCase(dbName)}_DB_CONSTRAINT_MAP = {`,
		...joined(blocks),
		"} as const",
		"",
	].join("\n")
}
