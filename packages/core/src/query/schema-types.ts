/** The configs and outputs of the list and retrieve query schemas. Declaration-only. */
import type * as z from "zod"

import type { FilterLimits } from "./filter.ts"
import type { LimitsGiven } from "./filter-validate.ts"
import type { RESERVED_LIST_KEYS, RESERVED_RETRIEVE_KEYS } from "./schema-params.ts"
import type { FieldType, FilterAST, ParsedFields, SortDirection, SortField } from "./types.ts"

type FieldsConfig = {
	relations?: readonly string[] | undefined
	relationFields?: Record<string, readonly string[]> | undefined
	scalars: readonly string[]
}

type OutputStableShape<T extends z.ZodRawShape = z.ZodRawShape> = {
	[K in keyof T]: z.ZodType<z.infer<T[K]>, z.infer<T[K]>>
}

/** Bounds on one list request; `maxFilterLength` is checked before the filter is parsed */
type ListQueryLimits = FilterLimits & { maxFilterLength: number; maxSearchTerms: number; maxSortKeys: number }

type PaginationConfig = {
	defaultLimit?: number | undefined
	maxLimit?: number | undefined
	/** The last page offset pagination serves; past it, a client pages by cursor. Default 10 000. */
	maxPage?: number | undefined
}

export type ReservedListKey = (typeof RESERVED_LIST_KEYS)[number]

export type ReservedRetrieveKey = (typeof RESERVED_RETRIEVE_KEYS)[number]

type ListQueryConfig<
	T extends OutputStableShape<T> = Record<never, never>,
	TSortFields extends readonly string[] = readonly string[],
> = {
	/** Extra params, validated and returned as they are; a name the schema owns is refused */
	extend?: (T & { [K in ReservedListKey]?: never | undefined }) | undefined
	fields?: FieldsConfig | undefined
	/** Fields `filter` may name. Omitted or empty: the endpoint takes no `filter`. */
	filter?: Record<string, FieldType> | undefined
	/** Accept `lang` (localized text). Omitted: the endpoint takes no `lang`. */
	lang?: true | undefined
	limits?: LimitsGiven<ListQueryLimits> | undefined
	/**
	 * Fields `q` searches, as published. Omitted: the endpoint takes no `q`.
	 * Declaring it obliges the handler to pass a search resolver to buildListQuery,
	 * which refuses a `q` it cannot apply.
	 */
	search?: readonly string[] | undefined
	pagination?: PaginationConfig | undefined
	sort: TSortFields
	/**
	 * The column the list breaks ties on, published as `stableTiebreak` (QL10 of r22b). Omitted:
	 * `id`, as buildListQuery breaks ties; a derived list names its `idColumn`'s.
	 */
	tiebreak?: string | undefined
}

type RetrieveQueryConfig<T extends z.ZodRawShape = z.ZodRawShape> = {
	/** Extra params, validated and returned as they are; a name the schema owns is refused */
	extend?: (T & { [K in ReservedRetrieveKey]?: never | undefined }) | undefined
	fields: FieldsConfig
	/** Accept `lang` (localized text). Omitted: the endpoint takes no `lang`. */
	lang?: true | undefined
}

type ListQueryOutput<TSortField extends string = string> = {
	cursor: string | undefined
	filterAst: FilterAST | null
	lang: string | undefined
	limit: number
	page: number | undefined
	parsedFields: ParsedFields | null
	parsedSort: Array<SortField<TSortField>>
	q: string | undefined
	sortOrderBy: Partial<Record<TSortField, SortDirection>>
	/**
	 * The schema's own maxPage on its output, which holds the page wherever it is read, a spread of
	 * this object included (C7 of r19). A parsed object built by hand leaves it out for the default
	 * maxPage, or states the bound it means (query/trusted.ts, U29)
	 */
	pageBound?: number | undefined
	/** The schema's own maxLimit, which holds the limit as `pageBound` holds the page (Q16 of r18, C7 of r19) */
	limitBound?: number | undefined
	/** The column the schema says the list breaks ties on, `id` by default, which a derived list's idColumn names */
	tiebreak?: string | undefined
	/** Always true: the filter and the order were checked against the endpoint's fields (query/trusted.ts) */
	validated: true
}

type RetrieveQueryOutput = {
	lang: string | undefined
	parsedFields: ParsedFields | null
}

export type {
	FieldsConfig,
	ListQueryConfig,
	ListQueryLimits,
	ListQueryOutput,
	OutputStableShape,
	PaginationConfig,
	RetrieveQueryConfig,
	RetrieveQueryOutput,
}
