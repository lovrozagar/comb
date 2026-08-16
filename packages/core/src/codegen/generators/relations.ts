/**
 * Relations Generator — pure transformer from TableMeta[].
 *
 * Generates db.{name}.relations.gen.ts from foreign key references.
 * Builds defineRelations graph from TableMeta FK data.
 */
import path from "node:path"
import pluralize from "pluralize"
import type { TableMeta } from "../analyzer-types.ts"
import { writeGenFile } from "../utils/fs.ts"

type RelationsConfig = {
	output: string
}

/** snake_case to camelCase */
function toCamelCase(s: string): string {
	return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
}

/**
 * Derive r.one relation name from FK column and referenced table.
 *
 * Pattern: if column is exactly `{refTable}_id`, name = camelCase(refTable).
 * If column is `{prefix}_{refTable}_id`, name = camelCase(prefix).
 * Otherwise fall back to stripping `_id` suffix and camelCasing.
 */
function deriveOneName(column: string, refTable: string): string {
	const withoutId = column.replace(/_id$/, "")

	/* exact match: customer_id -> customer */
	if (withoutId === refTable) {
		return toCamelCase(refTable)
	}

	/* prefix match: invited_by_user_id with refTable=user -> invitedBy */
	if (withoutId.endsWith(`_${refTable}`)) {
		const prefix = withoutId.slice(0, -(refTable.length + 1))
		if (prefix.length > 0) {
			return toCamelCase(prefix)
		}
	}

	/* fallback: just camelCase the column without _id */
	return toCamelCase(withoutId)
}

/** Derive r.many relation name: camelCase + pluralize the source table */
function deriveManyName(sourceTable: string): string {
	return pluralize(toCamelCase(sourceTable))
}

type OneRelation = { column: string; name: string; refColumn: string; refTable: string }
type ManyRelation = { name: string; sourceColumn: string; sourceTable: string }

/** Build the relations graph and generate code from analyzed tables */
export function generateRelations(tables: TableMeta[], tablesPath: string, config: RelationsConfig, cwd: string): void {
	const outputPath = path.resolve(cwd, config.output)

	/* Build relation entries per table */
	const oneRelations = new Map<string, OneRelation[]>()
	const manyRelations = new Map<string, ManyRelation[]>()

	for (const table of tables) {
		if (!oneRelations.has(table.varName)) {
			oneRelations.set(table.varName, [])
		}
		if (!manyRelations.has(table.varName)) {
			manyRelations.set(table.varName, [])
		}

		for (const field of table.fields) {
			if (!field.foreignKey) continue

			const fk = field.foreignKey

			/* r.one on the source table (table with the FK column) */
			const oneName = deriveOneName(fk.column, fk.refTable)
			const ones = oneRelations.get(table.varName)
			if (ones) {
				ones.push({
					column: fk.column,
					name: oneName,
					refColumn: fk.refColumn,
					refTable: fk.refTable,
				})
			}

			/* r.many on the target table (referenced table) */
			if (!manyRelations.has(fk.refTable)) {
				manyRelations.set(fk.refTable, [])
			}
			const manys = manyRelations.get(fk.refTable)
			if (manys) {
				const manyName = deriveManyName(table.varName)

				/* Deduplicate: if multiple FKs from same source table, disambiguate */
				const existing = manys.find((m) => m.sourceTable === table.varName && m.sourceColumn === fk.column)
				if (!existing) {
					manys.push({
						name: manyName,
						sourceColumn: fk.column,
						sourceTable: table.varName,
					})
				}
			}
		}
	}

	/* Handle name collisions for r.many when multiple FKs point to same target from same source */
	for (const [, manys] of manyRelations) {
		const nameCount = new Map<string, number>()
		for (const m of manys) {
			nameCount.set(m.name, (nameCount.get(m.name) ?? 0) + 1)
		}

		for (const m of manys) {
			const count = nameCount.get(m.name)
			if (count !== undefined && count > 1) {
				/* Disambiguate by appending "By" + camelCase(column without _id) */
				const suffix = toCamelCase(m.sourceColumn.replace(/_id$/, ""))
				const capitalSuffix = suffix.charAt(0).toUpperCase() + suffix.slice(1)
				m.name = `${m.name}By${capitalSuffix}`
			}
		}
	}

	/* Derive tables import from actual file name (handles both .gen.ts and .ts) */
	const tablesBasename = path.basename(tablesPath, ".ts")
	const tablesImport = `./${tablesBasename}`

	/* Generate output code */
	const lines: string[] = []
	lines.push(`import { defineRelations } from "drizzle-orm"`)
	lines.push(`import * as schema from "${tablesImport}"`)
	lines.push("")
	lines.push("export const relations = defineRelations(schema, (r) => ({")

	/* Sort tables alphabetically */
	const allTableNames = new Set<string>()
	for (const t of tables) {
		allTableNames.add(t.varName)
	}
	const sortedTableNames = [...allTableNames].sort()

	for (const tableName of sortedTableNames) {
		const ones = oneRelations.get(tableName) ?? []
		const manys = manyRelations.get(tableName) ?? []

		if (ones.length === 0 && manys.length === 0) continue

		lines.push(`\t${tableName}: {`)

		/* Sort all relations alphabetically by name */
		type RelationEntry = { kind: "many"; rel: ManyRelation } | { kind: "one"; rel: OneRelation }
		const entries: RelationEntry[] = [
			...manys.map((rel): RelationEntry => ({ kind: "many", rel })),
			...ones.map((rel): RelationEntry => ({ kind: "one", rel })),
		]
		entries.sort((a, b) => a.rel.name.localeCompare(b.rel.name))

		for (const entry of entries) {
			if (entry.kind === "one") {
				const { column, name, refColumn, refTable } = entry.rel
				lines.push(`\t\t${name}: r.one.${refTable}({`)
				lines.push(`\t\t\tfrom: r.${tableName}.${column},`)
				lines.push(`\t\t\tto: r.${refTable}.${refColumn},`)
				lines.push("\t\t}),")
			} else {
				const { name, sourceColumn, sourceTable } = entry.rel
				lines.push(`\t\t${name}: r.many.${sourceTable}({`)
				lines.push(`\t\t\tfrom: r.${tableName}.id,`)
				lines.push(`\t\t\tto: r.${sourceTable}.${sourceColumn},`)
				lines.push("\t\t}),")
			}
		}

		lines.push("\t},")
	}

	lines.push("}))")
	lines.push("")

	writeGenFile(outputPath, lines.join("\n"), "comb")

	/* Stats */
	let totalOnes = 0
	let totalManys = 0
	for (const [, ones] of oneRelations) totalOnes += ones.length
	for (const [, manys] of manyRelations) totalManys += manys.length

	console.log(`Generated relations: ${outputPath}`)
	console.log(`Tables: ${sortedTableNames.length}, r.one: ${totalOnes}, r.many: ${totalManys}`)
}
