/**
 * Constraint map generator — pure transformer from TableMeta[].
 *
 * Generates constraint maps from analyzed table metadata for database error handling.
 */
import path from "node:path"
import { commentText, dbIdentifiers, propertyName, stringLiteral } from "../utils/case.ts"
import type { TableMeta } from "../analyzer-types.ts"
import { pgIdentifier } from "../../identifier.ts"
import { writeGenFile } from "../utils/fs.ts"
import { enumCheckName } from "./enum-checks.ts"
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

type Dialect = "postgres" | "sqlite"

type ConstraintsConfig = {
	output: string
}

const conflict = (cause: string, errorKey: string): Constraint => ({ cause, errorKey, statusKey: "conflict" })

/**
 * The column-level and index-level unique constraints, keyed by the column's SQL name; a
 * composite index by its SQL columns together (`org_id,email`), as the engine reports the pair
 */
function uniqueOf(table: TableMeta): Record<string, Constraint> | undefined {
	const unique: Record<string, Constraint> = {}
	for (const field of table.fields.filter((f) => /\.unique\(/.test(f.raw))) {
		unique[field.sqlName] = conflict(
			`A record with this ${field.name} value already exists`,
			`${table.sqlName}_${field.name}_duplicate`,
		)
	}
	/* a partial index fails with the same "UNIQUE constraint failed: <table>.<column>" as a full one */
	for (const { columns } of [...table.uniqueIndexes, ...table.partialUniqueIndexes]) {
		/* the engine reports the columns' SQL names; the error key keeps the property names */
		const sqlNames = columns.map((col) => table.fields.find((f) => f.name === col)?.sqlName ?? col)
		const cause =
			columns.length === 1
				? `A record with this ${columns[0]} value already exists`
				: `A record with this ${columns.join(" and ")} combination already exists`
		unique[sqlNames.join(",")] = conflict(cause, `${table.sqlName}_${columns.join("_")}_duplicate`)
	}
	return Object.keys(unique).length > 0 ? unique : undefined
}

/* what a violated CHECK reports when its name follows none of comb's own conventions: what the handler reports unmapped */
const CHECK_FAILED = { cause: "Check constraint violated", statusKey: "bad_request" } as const

/**
 * The cause and status a CHECK reports. Only the two conventions comb itself writes are read from
 * a name, `_enum` and `_size`; any other word in a name says nothing reliable (a seats check named
 * `…_within_valid_range` is no date), so every other CHECK is a 400 as the handler's fallback (F27)
 */
function checkVerdict(name: string, expression: string): Omit<Constraint, "errorKey"> {
	if (name.endsWith("_enum")) return { cause: "Invalid enum value", statusKey: "bad_request" }
	const bytes = name.includes("_size") ? expression.match(/<=\s*(\d+)/)?.[1] : undefined
	if (bytes === undefined) return CHECK_FAILED
	return {
		cause: `Exceeds maximum size of ${Math.round(Number.parseInt(bytes, 10) / 1024)}KB`,
		statusKey: "bad_request",
	}
}

/** A CHECK's name under its table, which a name already starting with the table carries once (F35) */
const keyed = (table: TableMeta, name: string) =>
	name.startsWith(`${table.sqlName}_`) ? name : `${table.sqlName}_${name}`

/**
 * Each CHECK of a table by the name the engine reports: the declared ones and comb's own enum
 * CHECKs (F28), cut to what Postgres keeps of a name (F21). Two that cut to one fail codegen.
 */
function checksOf(table: TableMeta, dialect: Dialect): Record<string, Constraint> | undefined {
	const key = (name: string) => (dialect === "postgres" ? pgIdentifier(name) : name)
	const entries: Array<[string, string, Constraint]> = table.checkConstraints.map((chk) => [
		chk.name,
		key(chk.name),
		{ ...checkVerdict(chk.name, chk.expression), errorKey: `${keyed(table, chk.name)}_failed` },
	])
	for (const field of table.fields.filter((each) => (each.enumValues?.length ?? 0) > 0)) {
		const name = enumCheckName(table, field.name)
		entries.push([
			name,
			key(name),
			{ ...checkVerdict(name, ""), errorKey: `${table.sqlName}_${field.name}_enum_invalid` },
		])
	}
	const out: Record<string, Constraint> = {}
	const declared = new Map<string, string>()
	for (const [name, reported, constraint] of entries) {
		const first = declared.get(reported)
		if (first !== undefined)
			throw new Error(
				`${table.sqlName}: the CHECKs ${first} and ${name} share the 63 bytes Postgres keeps of their names; rename one`,
			)
		declared.set(reported, name)
		out[reported] = constraint
	}
	return entries.length > 0 ? out : undefined
}

function constraintsOf(table: TableMeta, dialect: Dialect): TableConstraints {
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
	const check = checksOf(table, dialect)
	if (check) entry.check = check
	return entry
}

/**
 * The constraint map of every table that has a constraint, keyed by SQL table name. An error key
 * two constraints would mint fails codegen, naming both: a client could not tell them apart, and
 * the one translation would name the wrong column for one (F20). Renaming the keys would break
 * every consumer's translations, so a repeat is refused instead.
 */
export function buildConstraintMap(tables: readonly TableMeta[], dialect: Dialect = "sqlite"): ConstraintMap {
	const map: ConstraintMap = {}
	const owner = new Map<string, string>()
	for (const table of tables) {
		const entry = constraintsOf(table, dialect)
		for (const [place, constraint] of placed(table.sqlName, entry)) {
			const first = owner.get(constraint.errorKey)
			if (first !== undefined)
				throw new Error(
					`the error key ${constraint.errorKey} names two constraints: ${first} and ${place}; rename a column`,
				)
			owner.set(constraint.errorKey, place)
		}
		if (Object.keys(entry).length > 0) map[table.sqlName] = entry
	}
	return map
}

/** Each constraint of a table's entry with where it stands: `user.unique.email` */
function placed(table: string, entry: TableConstraints): Array<[string, Constraint]> {
	const groups = (["check", "foreignKey", "unique"] as const).flatMap((group) =>
		Object.entries(entry[group] ?? {}).map(([name, constraint]): [string, Constraint] => [
			`${table}.${group}.${name}`,
			constraint,
		]),
	)
	return [...(entry.primaryKey ? [[`${table}.primaryKey`, entry.primaryKey] as [string, Constraint]] : []), ...groups]
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
	const constraintMap = buildConstraintMap(tables, ctx.dialect)

	writeGenFile(outputPath, generateConstraintMapCode(constraintMap, dbName), { generator: "comb", staged: ctx.staged })

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
		`${indent}errorKey: ${stringLiteral(constraint.errorKey)},`,
		`${indent}cause: ${stringLiteral(constraint.cause)},`,
		`${indent}statusKey: ${stringLiteral(constraint.statusKey)},`,
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
		`\t\t\t${propertyName(column)}: {`,
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
			`\t/* ${commentText(tableName)} table constraints */`,
			`\t${propertyName(tableName)}: {`,
			...joined(groups.map(([type, group]) => groupLines(type, group as Constraint | Record<string, Constraint>))),
			"\t}",
		]
	})
	return [
		`export const ${dbIdentifiers(dbName).constant}_DB_CONSTRAINT_MAP = {`,
		...joined(blocks),
		"} as const",
		"",
	].join("\n")
}
