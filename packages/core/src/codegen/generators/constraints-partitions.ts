/**
 * comb.config.ts's `partitions` checked against the analyzed tables, for the constraint map: each
 * partitioned table's partitions as its entry lists them (Q7 of r18).
 */
import type { TableMeta } from "../analyzer-types.ts"
import { byCodeUnit } from "../utils/order.ts"
import { qualifiedName } from "../utils/table-name.ts"

/**
 * Each partitioned table's partitions, keyed as the map keys a table, as `mapTable` reads a reported
 * one: in the parent's schema, so written without one. A parent no table is, a partition that is a
 * table or has two parents, and any on SQLite are refused (Q7 of r18)
 */
export function partitionsOf(
	tables: readonly TableMeta[],
	dialect: "postgres" | "sqlite",
	partitions: Readonly<Record<string, readonly string[]>>,
): Map<string, string[]> {
	const out = new Map<string, string[]>()
	if (Object.keys(partitions).length === 0) return out
	if (dialect === "sqlite")
		throw new Error("partitions: SQLite has no partitioned tables; list partitions on a Postgres database only")
	const tablesByKey = new Map(tables.map((table) => [qualifiedName(table), table]))
	const parentOf = new Map<string, string>()
	for (const [parent, names] of Object.entries(partitions).sort(([a], [b]) => byCodeUnit(a, b))) {
		const table = tablesByKey.get(parent)
		if (table === undefined)
			throw new Error(
				`partitions: ${JSON.stringify(parent)} is no table of this database; key each partitioned table as its constraint map does`,
			)
		const keys = names.map((name) => {
			if (name.includes("."))
				throw new Error(
					`partitions: ${JSON.stringify(parent)} lists ${JSON.stringify(name)}; name a partition without a schema, as it lives in its parent's`,
				)
			const key = qualifiedName({ schema: table.schema, sqlName: name })
			if (tablesByKey.has(key))
				throw new Error(
					`partitions: ${JSON.stringify(parent)} lists ${JSON.stringify(name)}, which is a table of this database, not a partition`,
				)
			const other = parentOf.get(key)
			if (other !== undefined && other !== parent)
				throw new Error(
					`partitions: ${JSON.stringify(name)} is listed under both ${JSON.stringify(other)} and ${JSON.stringify(parent)}; a partition has one parent`,
				)
			parentOf.set(key, parent)
			return key
		})
		out.set(parent, [...new Set(keys)].sort())
	}
	return out
}
