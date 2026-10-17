/**
 * Pre-generation validation for Drizzle table definitions.
 *
 * Tiered: hard errors (would produce invalid code) vs warnings (suspicious patterns). It reads
 * tables through the analyzer's own parser, so it checks exactly what codegen will generate from.
 */
import { SyntaxKind, type VariableDeclaration } from "ts-morph"
import { CURSOR_TIEBREAK_COLUMN } from "../../query/cursor.ts"
import { parseTable } from "../analyze-table.ts"
import type { FieldMeta, ImportsMeta, TableMeta } from "../analyzer-types.ts"
import { isTableDefinition, tableBuilders } from "./table-builders.ts"
import { createProjectFromTablesDir } from "./ts-morph.ts"

type ValidationResult = {
	errors: string[]
	warnings: string[]
}

type Declared = { optionsText: string; table: TableMeta }

const emptyImports = (): ImportsMeta => ({
	enumImports: new Map(),
	identifierValues: new Map(),
	identifiers: new Map(),
	jsonSchemaImports: new Set(),
})

/** The table `declaration` declares, with its options' source; a table comb cannot read is an error. */
function declaredTable(declaration: VariableDeclaration, report: ValidationResult): Declared | null {
	try {
		const table = parseTable(declaration, emptyImports())
		if (table === null) return null
		/* parseTable read a call, so the initializer is one */
		const args = declaration.getInitializerIfKindOrThrow(SyntaxKind.CallExpression).getArguments()
		return { optionsText: args[2]?.getText() ?? "", table }
	} catch (error) {
		// reason: an unreadable table is reported to the caller as a validation error
		report.errors.push(`${declaration.getName()}: ${(error as Error).message}`)
		return null
	}
}

/** Every table the project declares. */
function declaredTables(tablesPath: string, report: ValidationResult): Declared[] {
	const declared: Declared[] = []
	for (const file of createProjectFromTablesDir(tablesPath).getSourceFiles()) {
		const builders = tableBuilders(file)
		for (const statement of file.getVariableStatements()) {
			const declaration = statement.getDeclarations()[0]
			const text = declaration?.getInitializer()?.getText()
			if (declaration === undefined || text === undefined || !isTableDefinition(text, builders)) continue
			const table = declaredTable(declaration, report)
			if (table !== null) declared.push(table)
		}
	}
	return declared
}

function checkNames(declared: Declared[], report: ValidationResult): void {
	const sqlNames = new Set<string>()
	const varNames = new Set<string>()
	for (const { table } of declared) {
		if (sqlNames.has(table.sqlName))
			report.errors.push(`Duplicate SQL table name: "${table.sqlName}" (var: ${table.varName})`)
		if (varNames.has(table.varName)) report.errors.push(`Duplicate table variable name: "${table.varName}"`)
		sqlNames.add(table.sqlName)
		varNames.add(table.varName)
	}
}

function checkFields(table: TableMeta, report: ValidationResult): void {
	const seen = new Set<string>()
	for (const field of table.fields) {
		if (seen.has(field.name)) report.errors.push(`${table.varName}: duplicate field "${field.name}"`)
		seen.add(field.name)
	}
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
	if (key === undefined && !table.hasCompositePrimaryKey)
		report.warnings.push(`${table.varName}: no primary key detected`)
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

function checkConstraintNames({ optionsText, table }: Declared, report: ValidationResult): void {
	const names = new Set<string>()
	for (const match of optionsText.matchAll(/(?:uniqueIndex|check)\s*\(\s*["']([^"']+)["']/g)) {
		const name = match[1] as string
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
		if (field.enumValues === null) {
			report.warnings.push(`${at}: states declared but the enum values are a reference comb cannot read`)
			continue
		}
		const machine: Machine = { at, field, report, values: field.enumValues }
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

function checkReferences(declared: Declared[], report: ValidationResult): void {
	const varNames = new Set(declared.map(({ table }) => table.varName))
	for (const { table } of declared) {
		for (const field of table.fields) {
			const target = field.foreignKey?.refTable
			if (target === undefined || varNames.has(target)) continue
			report.errors.push(
				`${table.varName}.${field.name}: FK references "${target}" which is not defined in tables file`,
			)
		}
	}
}

/**
 * Validate tables file before codegen. Returns errors + warnings.
 * Hard errors should abort generation. Warnings are informational.
 */
export function validateTables(tablesPath: string): ValidationResult {
	const report: ValidationResult = { errors: [], warnings: [] }
	const declared = declaredTables(tablesPath, report)
	checkNames(declared, report)
	for (const entry of declared) {
		checkFields(entry.table, report)
		checkMachines(entry.table, report)
		checkConstraintNames(entry, report)
		checkPrimaryKey(entry.table, report)
	}
	checkReferences(declared, report)
	return report
}
