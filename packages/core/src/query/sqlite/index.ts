/**
 * @lovrozagar/comb/query/sqlite — SQLite-specific SQL generation.
 */

/* List query builder */
export {
	applyListQuery,
	buildDerivedListQuery,
	buildListQuery,
	type BuildDerivedListQueryOpts,
	type BuildListQueryOpts,
	type ListQueryParsed,
	type ListQueryResult,
} from "./build-list-query.ts"

/* SQL generation internals (used by buildListQuery, available for advanced use) */
export { conditionToSQL, filterToSQL, sortToOrderBy } from "./executor.ts"

/* Raw SQL filter builders */
export { buildConditionSQL, buildFilterSQL, type FilterSQLConfig } from "./filter-sql.ts"

/* Cursor pagination */
export { buildCursorSQL, type CursorSQLConfig } from "./pagination.ts"

/* FTS5 search */
export {
	buildFtsHighlight,
	buildFtsMatch,
	buildFtsWhere,
	buildFtsWhereWithSpellfix,
	type SpellfixDb,
	sanitizeFtsTerm,
} from "./search.ts"

/* LIKE search */
export { likeSearch, type LikeSearchResolver } from "./search.ts"

/* JSON column helpers */
export {
	buildScalarJsonParts,
	jsonBool,
	jsonCol,
	jsonColAs,
	jsonNullable,
	type ScalarColDef,
	SQL_SORT_DIR,
} from "./sql.ts"

/* Types */
export type { QueryExecutorConfig, QueryExecutorResult, RelationConfig } from "./types.ts"
