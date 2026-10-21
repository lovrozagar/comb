/**
 * @lovrozagar/comb/query — DB-agnostic query helpers.
 *
 * Parsers, validators, Zod schemas, and pagination utilities.
 * For SQLite-specific SQL generation, use @lovrozagar/comb/query/sqlite.
 */

/* Cursor & pagination */
export {
	createCursor,
	CURSOR_TIEBREAK_COLUMN,
	cursorProblem,
	effectiveNulls,
	MAX_CURSOR_LENGTH,
	readCursor,
	sortSignature,
} from "./cursor.ts"
export type { CursorPayload, DecodedCursor, PaginationMeta } from "./cursor.ts"
export { MIN_CURSOR_SECRET_BYTES } from "./cursor-sign.ts"

/* Drizzle relational helpers */
export { type DrizzleListOptions, queryHelpers } from "./drizzle.ts"

/* Sparse fieldset parser (PostgREST select) */
export { filterBySelect, parseSelect } from "./fields.ts"

/* Filter parser + validator + order parser */
/* The grammar itself — so neither honey nor oat has to guess how a probe value
   is written. COMB_FILTER_GRAMMAR is the identifier oat calls `grammar`. */
export {
	FILTER_LIMITS,
	FILTER_OPERATORS,
	type FilterLimits,
	type FilterValidationResult,
	OPERATORS_BY_TYPE,
	parseFilter,
	parseOrder,
	validateFilter,
} from "./filter.ts"
export { escapeLike, globPattern, likePattern } from "./like.ts"
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
	PAGINATION_DEFAULTS,
	paginationResponseSchema,
	type RetrieveQueryConfig,
	type RetrieveQueryOutput,
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
	ParsedFields,
	SortDirection,
	SortField,
	SortNulls,
} from "./types.ts"
