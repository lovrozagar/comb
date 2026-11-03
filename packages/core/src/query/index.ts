/**
 * @lovrozagar/comb/query — DB-agnostic query helpers.
 *
 * Parsers, validators, Zod schemas, and pagination utilities.
 * For SQLite-specific SQL generation, use @lovrozagar/comb/query/sqlite.
 */

/* Cursor & pagination */
export {
	CursorRef,
	CURSOR_TIEBREAK_COLUMN,
	cursorProblem,
	effectiveNulls,
	MAX_CURSOR_LENGTH,
	readCursor,
	sortSignature,
} from "./cursor.ts"
export type { CursorOptions, CursorPayload, CursorValue, DecodedCursor, PaginationMeta } from "./cursor.ts"
export { type ListExtra, type ListRow, paginate } from "./pagination.ts"
export { createCursor } from "./cursor-mint.ts"
export { MIN_CURSOR_SECRET_BYTES } from "./cursor-seal.ts"

/* Drizzle relational helpers, and each function queryHelpers groups (KT4 of r22b) */
export { drizzleListOptions, type DrizzleListOptions, drizzleProject, queryHelpers } from "./drizzle.ts"
export { extractFilterValue, extractFilterValues } from "./filter-values.ts"

/* Sparse fieldset parser (PostgREST select) */
export { filterBySelect, parseSelect } from "./fields.ts"

/* Filter parser + validator + order parser */
/* The grammar itself — so neither honey nor oat has to guess how a probe value
   is written. COMB_FILTER_GRAMMAR is the identifier oat calls `grammar`. */
export {
	FILTER_LIMITS,
	FILTER_OPERATORS,
	type FilterField,
	type FilterFieldSpec,
	type FilterLimits,
	type FilterValidationResult,
	OPERATORS_BY_TYPE,
	parseFilter,
	parseFilterNumber,
	parseOrder,
	validateFilter,
} from "./filter.ts"
export { escapeLike, globPattern, likePattern } from "./like.ts"
/* an ISO date filter's validated value: the instant, by its milliseconds and its text (Q4 of r17) */
export { IsoInstant } from "./iso-date.ts"
export { COMB_FILTER_GRAMMAR, type CombFilterGrammar } from "../meta.ts"

/* Zod schema builders */
export {
	createListQuerySchema,
	createRetrieveQuerySchema,
	type FieldsConfig,
	LIST_QUERY_LIMITS,
	type ListQueryConfig,
	type ListQueryLimits,
	type ListQueryOutput,
	type ListQuerySchema,
	PAGINATION_DEFAULTS,
	paginationResponseSchema,
	type RetrieveQueryConfig,
	type RetrieveQueryOutput,
	type RetrieveQuerySchema,
} from "./schema.ts"

/* OpenAPI description / example constants for reuse by downstream schemas */
export {
	CURSOR_DESCRIPTION,
	CURSOR_EXAMPLES,
	filterParamMeta,
	LANG_DESCRIPTION,
	LANG_EXAMPLES,
	LIMIT_DESCRIPTION,
	LIMIT_EXAMPLES,
	orderParamMeta,
	PAGE_DESCRIPTION,
	PAGE_EXAMPLES,
	searchParamMeta,
	SELECT_DESCRIPTION,
	SELECT_EXAMPLES,
} from "./descriptions.ts"

/* Translation resolver */
export { resolveTranslation, type TranslationResolverInput } from "./translation.ts"

/* Types */
export type {
	ComputedFilterResolver,
	ComputedSortResolver,
	FieldSelection,
	FieldType,
	FilterAST,
	FilterCondition,
	FilterGroup,
	FilterOperator,
	ListQueryCapabilities,
	ListQueryInput,
	ParsedFields,
	SortDirection,
	SortField,
	SortNulls,
} from "./types.ts"
export type { CursorId } from "./cursor.ts"
export type { KeysetKind } from "./cursor-mint.ts"
export type { ListPagination, PaginationResponse } from "./pagination.ts"
export type { RelationalTable } from "./drizzle.ts"
export type { OutputStableShape, PaginationConfig, ReservedListKey, ReservedRetrieveKey } from "./schema-types.ts"
export type { ParamMeta } from "./descriptions.ts"
export type { PaginationResponseSchema } from "./schema.ts"
export type { ListQueryRequest, ListQueryShape } from "./list-schema.ts"
export type { RetrieveRequest, RetrieveShape } from "./retrieve-schema.ts"
