/**
 * What a consumer's compiler sees from buildFilterSQL's column map (Q5 of r18): a mapped column is
 * `{ column, kind }` only. Checked by `bun run typecheck`; nothing here runs.
 */
import type { FilterSQLConfig } from "../../src/query/sqlite/index.ts"

export const mapped: FilterSQLConfig = { columnMap: { name: { column: "name", kind: "text" } }, tableAlias: "u" }

// @ts-expect-error a bare column name says nothing of what it stores: `{ column, kind: "as-is" }` since 0.17
export const named: FilterSQLConfig = { columnMap: { name: "name" }, tableAlias: "u" }
