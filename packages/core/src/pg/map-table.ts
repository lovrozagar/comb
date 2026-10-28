/**
 * The key a violated Postgres table has in the app's constraint maps (F51). Codegen keys a table
 * of a pgSchema by `schema.table` and any other by its bare name, which lives in the configured
 * schema (search_path: public, comb's own app, or another). So `schema.table` is looked up first,
 * and the bare table answers unless the error's schema is one a qualified entry names: a schema'd
 * table never takes another schema's bare entry, and an unqualified one keeps its own. A qualified
 * key's schema is what stands before its first dot.
 */
import type { ConstraintMap } from "../types.ts"

export function mapTable(
	maps: readonly ConstraintMap[],
	{ schema, table }: { schema: string | undefined; table: string | undefined },
): string | undefined {
	if (table === undefined || schema === undefined) return table
	const qualified = `${schema}.${table}`
	const keys = maps.flatMap((map) => Object.keys(map))
	if (keys.includes(qualified)) return qualified
	const schemas = new Set(keys.filter((key) => key.includes(".")).map((key) => key.slice(0, key.indexOf("."))))
	return schemas.has(schema) ? qualified : table
}
