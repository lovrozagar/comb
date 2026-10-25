/** The diagrams' compact summary, for an AI's context: each table's own columns, and who references whom */
import type { Relation, Table } from "./diagram-types.ts"

/** Columns nearly every table carries, left out of the compact summary */
function isCommonColumn(name: string): boolean {
	return ["id", "created_at", "updated_at", "deleted_at", "metadata", "createdAt", "updatedAt", "deletedAt"].includes(
		name,
	)
}

/** The summary's shorthand for a delete rule; rules without one print nothing */
function deleteSuffix(onDelete: string | undefined): string {
	switch (onDelete) {
		case "cascade":
			return "[c]"
		case "restrict":
			return "[r]"
		case "set null":
			return "[n]"
		default:
			return ""
	}
}

function summaryTableLines(tables: Table[]): string[] {
	return tables.map((t, i) => {
		const cols = t.columns.filter((c) => !isCommonColumn(c.name)).map((c) => c.name)
		return `${i + 1}. ${t.name}: ${cols.length > 0 ? cols.join(", ") : "(only common cols)"}`
	})
}

/** One line per referenced table, by 1-based table number (0 when outside the file), most referenced first */
function summaryRefLines(tables: Table[]): string[] {
	const tableIndex = new Map(tables.map((t, i) => [t.name, i + 1]))
	const byTarget = new Map<number, string[]>()
	for (const [i, table] of tables.entries()) {
		const refs = [
			...table.columns.flatMap(({ name, reference }) => (reference ? [{ name, ...reference }] : [])),
			...table.foreignKeys.map((fk) => ({ ...fk, name: `(${fk.columns.join(", ")})` })),
		]
		for (const { name, onDelete, table: to } of refs) {
			const targetIdx = tableIndex.get(to) as number
			byTarget.set(targetIdx, [...(byTarget.get(targetIdx) ?? []), `${i + 1}.${name}${deleteSuffix(onDelete)}`])
		}
	}
	return [...byTarget]
		.sort(([a], [b]) => a - b)
		.sort(([, a], [, b]) => b.length - a.length)
		.map(([targetIdx, refs]) => `${targetIdx} <- ${refs.join(", ")}`)
}

export function generateCompactAI(tables: Table[], relations: Relation[]): string {
	return [
		`# ${tables.length} tables, ${relations.length} FKs`,
		"# [c]=cascade [r]=restrict [n]=set null",
		"# Columns exclude: id, createdAt, updatedAt, deletedAt, metadata",
		"",
		"## Tables & Columns",
		...summaryTableLines(tables),
		"",
		"## FK refs (target <- source.col)",
		...summaryRefLines(tables),
	].join("\n")
}
