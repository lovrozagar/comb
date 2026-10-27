/**
 * The constraint map as the generated file writes it: tables, groups and columns sorted, each
 * constraint an `{ errorKey, cause, statusKey }` object, and a table's referenced columns a list.
 */
import { commentText, dbIdentifiers, propertyName, stringLiteral } from "../utils/case.ts"
import { byCodeUnit } from "../utils/order.ts"

export type Constraint = {
	cause: string
	errorKey: string
	statusKey: string
}

export type TableConstraints = {
	check?: Record<string, Constraint>
	foreignKey?: Record<string, Constraint>
	primaryKey?: Constraint
	referenced?: string[]
	unique?: Record<string, Constraint>
}

export type ConstraintMap = Record<string, TableConstraints>

/** Entries in the order of their keys, by code unit (F40) */
const byKey = ([a]: [string, unknown], [b]: [string, unknown]): number => byCodeUnit(a, b)

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

function groupLines(type: string, group: Constraint | Record<string, Constraint> | string[]): string[] {
	if (Array.isArray(group))
		return [
			"\t\t/* columns other tables' foreign keys reference */",
			`\t\treferenced: [${group.map(stringLiteral).join(", ")}]`,
		]
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
export function generateConstraintMapCode(map: ConstraintMap, dbName: string): string {
	const tables = Object.entries(map).sort(byKey)
	const blocks = tables.map(([tableName, constraints]) => {
		const groups = Object.entries(constraints).sort(byKey)
		return [
			`\t/* ${commentText(tableName)} table constraints */`,
			`\t${propertyName(tableName)}: {`,
			...joined(groups.map(([type, group]) => groupLines(type, group))),
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
