/**
 * Enum CHECK constraint generator — produces per-table check functions
 * that enforce enum values at the database level.
 *
 * Generated output:
 * ```ts
 * import { check } from "drizzle-orm/sqlite-core"
 * import { sql } from "drizzle-orm"
 *
 * export function userEnumChecks(table: Record<string, unknown>) {
 *   return [
 *     check("user_role_enum", sql`${table.role} IN ('admin', 'user', 'guest')`),
 *   ]
 * }
 * ```
 */
import path from "node:path"
import type { TableMeta } from "../analyzer-types.ts"
import { stringLiteral } from "../utils/case.ts"
import { writeGenFile } from "../utils/fs.ts"
import type { GeneratorContext } from "./context-types.ts"

type EnumChecksConfig = {
	output: string
}

type EnumField = {
	fieldName: string
	values: string[]
}

/** The name of the CHECK comb writes for an enum column; the constraint map keys its entry by it */
export const enumCheckName = (table: Pick<TableMeta, "sqlName">, fieldName: string): string =>
	`${table.sqlName}_${fieldName}_enum`

function getEnumFields(table: TableMeta): EnumField[] {
	const result: EnumField[] = []

	for (const field of table.fields) {
		if (field.enumValues && field.enumValues.length > 0) {
			result.push({
				fieldName: field.name,
				values: field.enumValues,
			})
		}
	}

	return result
}

function toCamelCase(s: string): string {
	return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
}

/**
 * A value as an SQL string literal's body, written inside a TS template literal: the SQL quote is
 * doubled, then everything a template treats specially (backslash, backtick, `${`, line breaks).
 */
function escapeValue(val: string): string {
	return val
		.replace(/'/g, "''")
		.replace(/\\/g, "\\\\")
		.replace(/`/g, "\\`")
		.replace(/\$\{/g, "\\${")
		.replace(/\n/g, "\\n")
		.replace(/\r/g, "\\r")
}

export function generateEnumChecks(ctx: GeneratorContext, config: EnumChecksConfig): void {
	const { dbName, tables } = ctx.analysis
	const { cwd } = ctx
	const outputPath = path.resolve(cwd, config.output)

	const tablesWithEnums: Array<{ enumFields: EnumField[]; table: TableMeta }> = []

	for (const table of tables) {
		const enumFields = getEnumFields(table)
		if (enumFields.length > 0) {
			tablesWithEnums.push({ enumFields, table })
		}
	}

	if (tablesWithEnums.length === 0) {
		ctx.log(`No enum fields found in ${dbName} — skipping enum-checks generation`)
		return
	}

	const lines: string[] = []
	/* the return type annotated, so a consumer's isolatedDeclarations compiles the file (K17 of r17) */
	lines.push(
		`import { check, type CheckBuilder } from "drizzle-orm/${ctx.dialect === "postgres" ? "pg" : "sqlite"}-core"`,
	)
	lines.push(`import { sql } from "drizzle-orm"`)
	lines.push("")

	for (const { enumFields, table } of tablesWithEnums) {
		const fnName = `${toCamelCase(table.varName)}EnumChecks`
		lines.push(`export function ${fnName}(table: Record<string, unknown>): CheckBuilder[] {`)
		lines.push("\treturn [")

		for (const ef of enumFields) {
			const inList = ef.values.map((v) => `'${escapeValue(v)}'`).join(", ")
			const checkName = enumCheckName(table, ef.fieldName)
			/* bracket access keeps the generated file valid under noPropertyAccessFromIndexSignature */
			lines.push(
				`\t\tcheck(${stringLiteral(checkName)}, sql\`\${table[${JSON.stringify(ef.fieldName)}]} IN (${inList})\`),`,
			)
		}

		lines.push("\t]")
		lines.push("}")
		lines.push("")
	}

	writeGenFile(outputPath, lines.join("\n"), { generator: "comb", staged: ctx.staged })

	let totalEnums = 0
	for (const { enumFields } of tablesWithEnums) {
		totalEnums += enumFields.length
	}

	ctx.log(`Generated enum checks for ${dbName} at: ${outputPath}`)
	ctx.log(`Tables: ${tablesWithEnums.length}, Enum columns: ${totalEnums}`)
}
