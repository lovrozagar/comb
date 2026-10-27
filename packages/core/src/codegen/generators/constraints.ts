/**
 * Constraint map generator — pure transformer from TableMeta[].
 *
 * Generates constraint maps from analyzed table metadata for database error handling.
 */
import path from "node:path"
import type { FieldMeta, TableMeta } from "../analyzer-types.ts"
import { pgIdentifier } from "../../identifier.ts"
import { writeGenFile } from "../utils/fs.ts"
import { enumCheckName } from "./enum-checks.ts"
import {
	type Constraint,
	type ConstraintMap,
	generateConstraintMapCode,
	type TableConstraints,
} from "./constraints-code.ts"
import type { GeneratorContext } from "./context-types.ts"

type Dialect = "postgres" | "sqlite"

type ConstraintsConfig = {
	output: string
}

const conflict = (cause: string, errorKey: string): Constraint => ({ cause, errorKey, statusKey: "conflict" })

/**
 * The column-level and index-level unique constraints, keyed by the column's SQL name; a
 * composite index by its SQL columns together (`org_id,email`), as the engine reports the pair; an
 * index on an expression by its name
 */
function uniqueOf(table: TableMeta): Record<string, Constraint> | undefined {
	const unique: Record<string, Constraint> = {}
	for (const field of table.fields.filter((f) => f.unique !== null)) {
		unique[field.sqlName] = conflict(
			`A record with this ${field.name} value already exists`,
			`${table.sqlName}_${field.name}_duplicate`,
		)
	}
	/* a partial index fails with the same "UNIQUE constraint failed: <table>.<column>" as a full one */
	for (const { columns } of [...table.uniqueIndexes, ...table.partialUniqueIndexes]) {
		/* the engine reports the columns' SQL names; the error key keeps the property names */
		const sqlNames = columns.map((col) => (table.fields.find((f) => f.name === col) as FieldMeta).sqlName)
		const cause =
			columns.length === 1
				? `A record with this ${columns[0]} value already exists`
				: `A record with this ${columns.join(" and ")} combination already exists`
		unique[sqlNames.join(",")] = conflict(cause, `${table.sqlName}_${columns.join("_")}_duplicate`)
	}
	/* an index on an expression is reported by its name, which the handlers look up under unique (F14) */
	for (const { expression, name } of table.expressionIndexes)
		unique[name] = conflict(`A record with this ${expression} value already exists`, `${name}_duplicate`)
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
 * The SQL the reader renders comb's enum CHECK of a column to, once a table applies it: the column
 * by its SQL name, and each value a literal (F47)
 */
const enumCheckExpression = (sqlName: string, values: readonly string[]): string =>
	`"${sqlName}" IN (${values.map((value) => `'${value.replaceAll("'", "''")}'`).join(", ")})`

/**
 * The declared CHECKs of a table that are not comb's own enum CHECK, applied: one under comb's
 * name for an enum column is comb's when it checks what comb writes, and refused otherwise (F47)
 */
function declaredChecks(table: TableMeta, enums: readonly FieldMeta[]): TableMeta["checkConstraints"] {
	return table.checkConstraints.filter((chk) => {
		const field = enums.find((each) => enumCheckName(table, each.name) === chk.name)
		if (field === undefined) return true
		if (chk.expression === enumCheckExpression(field.sqlName, field.enumValues as string[])) return false
		throw new Error(
			`${table.sqlName}: the CHECK ${chk.name} takes the name comb gives the enum CHECK of ${table.sqlName}.${field.name}, but checks something else; rename it`,
		)
	})
}

/**
 * Each CHECK of a table by the name the engine reports: the declared ones and comb's own enum
 * CHECKs (F28), cut to what Postgres keeps of a name (F21). Two of one name, or that cut to one,
 * fail codegen.
 */
function checksOf(table: TableMeta, dialect: Dialect): Record<string, Constraint> | undefined {
	const key = (name: string) => (dialect === "postgres" ? pgIdentifier(name) : name)
	const enums = table.fields.filter((each) => (each.enumValues?.length ?? 0) > 0)
	const entries: Array<[string, string, Constraint]> = declaredChecks(table, enums).map((chk) => [
		chk.name,
		key(chk.name),
		{ ...checkVerdict(chk.name, chk.expression), errorKey: `${keyed(table, chk.name)}_failed` },
	])
	for (const field of enums) {
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
		if (first === name) throw new Error(`${table.sqlName}: two CHECKs are named ${name}; rename one`)
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
 * Each table's columns some foreign key points at, by SQL name, sorted and once each: a composite
 * key's column by column, and a table's reference to itself among them (U43)
 */
function referencedColumns(tables: readonly TableMeta[]): Map<string, string[]> {
	const out = new Map<string, Set<string>>()
	for (const fk of tables.flatMap((table) => table.fields.flatMap((field) => field.foreignKey ?? []))) {
		/* the analyzer refuses a reference to a table the tables file does not export, so each target is here */
		const target = tables.find((table) => table.varName === fk.refTable) as TableMeta
		for (const column of fk.key?.refColumns ?? [fk.refColumn]) {
			const { sqlName } = target.fields.find((field) => field.name === column) as FieldMeta
			out.set(target.sqlName, (out.get(target.sqlName) ?? new Set()).add(sqlName))
		}
	}
	return new Map([...out].map(([table, columns]) => [table, [...columns].sort()]))
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
	const referenced = referencedColumns(tables)
	for (const table of tables) {
		const entry = constraintsOf(table, dialect)
		const columns = referenced.get(table.sqlName)
		if (columns !== undefined) entry.referenced = columns
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
