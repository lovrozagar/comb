/**
 * Pre-generation validation of the tables codegen read at runtime.
 *
 * Tiered: hard errors (would produce invalid code) vs warnings (suspicious patterns). It checks the
 * analysis every generator consumes, so it checks exactly what codegen will generate from.
 */
import { CURSOR_TIEBREAK_COLUMN } from "../../query/cursor.ts"
import type { AnalysisResult, FieldMeta, TableMeta } from "../analyzer-types.ts"
import { snakeToPascal, subpathName } from "./case.ts"
import { qualifiedName } from "./table-name.ts"

type ValidationResult = {
	errors: string[]
	warnings: string[]
}

/**
 * A table's generated path segment, which its DTO, rqb-cols and sql-cols directories all take
 * (`subpathName`, C20): two tables on one segment would replace each other's files, so both are named
 */
function checkPaths(varName: string, paths: Map<string, string>, report: ValidationResult): void {
	const segment = subpathName(varName)
	const taken = paths.get(segment)
	if (taken !== undefined && taken !== varName)
		report.errors.push(`Tables ${taken} and ${varName} both generate the path "${segment}"; rename one`)
	paths.set(segment, taken ?? varName)
}

function checkNames(tables: readonly TableMeta[], report: ValidationResult): void {
	const sqlNames = new Set<string>()
	/* the generated type names (post_tag and postTag both make PostTag) and the id prefixes, by the table that took them */
	const typeNames = new Map<string, string>()
	const prefixes = new Map<string, string>()
	const paths = new Map<string, string>()
	for (const table of tables) {
		checkPaths(table.varName, paths, report)
		/* auth.users beside the app's users is two tables (F51) */
		const name = qualifiedName(table)
		if (sqlNames.has(name)) report.errors.push(`Duplicate SQL table name: "${name}" (var: ${table.varName})`)
		sqlNames.add(name)
		const typeName = snakeToPascal(table.varName)
		const typed = typeNames.get(typeName)
		if (typed !== undefined && typed !== table.varName)
			report.errors.push(`Tables ${typed} and ${table.varName} both generate the type name "${typeName}"`)
		typeNames.set(typeName, typed ?? table.varName)
		const prefixed = table.idPrefix === null ? undefined : prefixes.get(table.idPrefix)
		if (prefixed !== undefined)
			report.errors.push(
				`Tables ${prefixed} and ${table.varName} share the id prefix "${table.idPrefix}"; ids of one would pass for the other`,
			)
		if (table.idPrefix !== null) prefixes.set(table.idPrefix, prefixed ?? table.varName)
	}
}

function checkFields(table: TableMeta, report: ValidationResult): void {
	/* A table has one tenant boundary or none. Two declarations have no safe resolution —
	   picking either would publish a boundary nobody chose — so the fact is dropped and reported. */
	const tenants = table.fields.filter((f) => f.constraints.tenant).map((f) => f.name)
	if (tenants.length > 1) {
		report.errors.push(
			`${table.varName}: ${tenants.length} columns declare { tenant: true } (${tenants.join(", ")}). ` +
				`A table scopes to at most one tenant column.`,
		)
	}
}

function checkPrimaryKey(table: TableMeta, report: ValidationResult): void {
	const key = table.fields.find((f) => f.isPrimaryKey)
	if (table.hasCompositePrimaryKey) {
		report.warnings.push(
			`${table.varName}: composite primary key, so no entity stamp is published (docs/meta-contract.md §6.4)`,
		)
	} else if (key === undefined) report.warnings.push(`${table.varName}: no primary key detected`)
	/* Keyset pagination resolves its tiebreak column by the property name CURSOR_TIEBREAK_COLUMN.
	   A warning, not an error: join, config and lookup tables are never listed, and for those the
	   property name is a free choice codegen has no business blocking. buildListQuery throws when
	   it is actually asked to page such a table (docs/meta-contract.md §7). */
	if (key === undefined || table.hasCompositePrimaryKey || key.name === CURSOR_TIEBREAK_COLUMN) return
	report.warnings.push(
		`${table.varName}: primary key is declared as "${key.name}", so this table cannot be ` +
			`cursor-paginated — buildListQuery resolves its tiebreak by the property name ` +
			`"${CURSOR_TIEBREAK_COLUMN}". Harmless if the table is never listed; otherwise rename the ` +
			`property to "${CURSOR_TIEBREAK_COLUMN}" (the SQL column name is unaffected).`,
	)
}

function checkConstraintNames(table: TableMeta, report: ValidationResult): void {
	const names = new Set<string>()
	const declared = [
		...table.uniqueIndexes,
		...table.partialUniqueIndexes,
		...table.expressionIndexes,
		...table.checkConstraints,
	]
	for (const { name } of declared) {
		if (names.has(name)) report.warnings.push(`${table.varName}: duplicate constraint name "${name}"`)
		names.add(name)
	}
}

type Machine = { at: string; field: FieldMeta; report: ValidationResult; values: string[] }

/* a typo silently disables a rule, so every name is checked against the value list */
function checkMachineNames({ at, field, report, values }: Machine): void {
	const known = new Set(values)
	const states = field.states!
	const named = (names: string[], where: string) => {
		for (const n of names)
			if (!known.has(n)) report.errors.push(`${at}: ${where} names "${n}", which is not a declared value`)
	}
	if (states.initial !== null) named([states.initial], "initial")
	named(states.terminal ?? [], "terminal")
	for (const [from, to] of Object.entries(states.transitions ?? {})) {
		named([from], "transitions")
		named(to, `transitions.${from}`)
	}
}

/* A map that names every non-terminal is "declared in full": unreachable states are then almost
   always a rename that missed a spot. A partial map is how an app declares only the part it knows. */
function checkMachineGraph({ at, field, report, values }: Machine): void {
	const states = field.states!
	const transitions = states.transitions
	if (transitions === null) return
	const terminal = new Set(states.terminal ?? [])
	for (const from of Object.keys(transitions)) {
		if (terminal.has(from))
			report.errors.push(`${at}: "${from}" is listed as terminal but also has outgoing transitions`)
	}
	const declaredFull = values.filter((v) => !terminal.has(v)).every((v) => Object.hasOwn(transitions, v))
	if (declaredFull) {
		const reachable = new Set([
			...(states.initial === null ? [] : [states.initial]),
			...Object.values(transitions).flat(),
		])
		for (const state of values) {
			if (!reachable.has(state))
				report.errors.push(`${at}: "${state}" is neither initial nor reachable through any transition`)
		}
	}
	for (const [from, to] of Object.entries(transitions)) {
		if (to.length > 0 || terminal.has(from) || !values.includes(from)) continue
		;(declaredFull ? report.errors : report.warnings).push(
			`${at}: "${from}" has no outgoing transitions and is not terminal`,
		)
	}
}

function checkMachines(table: TableMeta, report: ValidationResult): void {
	const declaring = table.fields.filter((f) => f.states !== null)
	for (const field of declaring) {
		const at = `${table.varName}.${field.name}`
		/* a machine is c.enum's third argument, so its values are read with it */
		const machine: Machine = { at, field, report, values: field.enumValues as string[] }
		checkMachineNames(machine)
		checkMachineGraph(machine)
	}
	/* v1 publishes at most one machine per table; say so rather than letting the extra one vanish */
	if (declaring.length > 1) {
		report.warnings.push(
			`${table.varName}: ${declaring.length} columns declare a state machine (${declaring.map((f) => f.name).join(", ")}). ` +
				`Only the first is published.`,
		)
	}
}

/**
 * Validate the analysis before codegen. Returns errors + warnings.
 * Hard errors should abort generation. Warnings are informational.
 */
export function validateTables(analysis: AnalysisResult): ValidationResult {
	const report: ValidationResult = { errors: [], warnings: [] }
	checkNames(analysis.tables, report)
	for (const table of analysis.tables) {
		checkFields(table, report)
		checkMachines(table, report)
		checkConstraintNames(table, report)
		checkPrimaryKey(table, report)
	}
	return report
}
