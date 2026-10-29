/** The unique indexes an entity payload publishes, read as readCombEntityMeta reads them: absent, none; malformed, refused */
import type { PartialUniqueIndexMeta, UniqueIndexMeta } from "./contract.ts"

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

const isStringArray = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every((item) => typeof item === "string")

/**
 * `uniqueIndexes` arrived in a later comb than the contract's v1, so a payload
 * without it is normal and reads as [] — absence is not an error, only a
 * malformed value is.
 */
function readUniqueIndexes(raw: unknown): UniqueIndexMeta[] | "invalid" {
	if (raw === undefined) return []
	if (!Array.isArray(raw)) return "invalid"

	const indexes: UniqueIndexMeta[] = []
	for (const item of raw) {
		if (!isRecord(item)) return "invalid"
		const columns = item["columns"]
		const name = item["name"]
		if (!isStringArray(columns) || columns.length === 0 || typeof name !== "string") return "invalid"
		indexes.push({ columns, name })
	}
	return indexes
}

/**
 * `partialUniqueIndexes` arrived in 0.15, after `uniqueIndexes`: absent, it reads as []; each needs
 * its predicate, without which it would read as the uniqueness it is not (C7)
 */
function readPartialUniqueIndexes(raw: unknown): PartialUniqueIndexMeta[] | "invalid" {
	if (raw === undefined) return []
	if (!Array.isArray(raw)) return "invalid"
	const indexes = readUniqueIndexes(raw)
	if (indexes === "invalid") return "invalid"
	const wheres = raw.map((item) => (item as Record<string, unknown>)["where"])
	if (!wheres.every((where) => typeof where === "string" && where !== "")) return "invalid"
	return indexes.map((index, i) => ({ ...index, where: wheres[i] as string }))
}

export { isRecord, isStringArray, readPartialUniqueIndexes, readUniqueIndexes }
