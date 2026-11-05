/** The configs and outputs of the list and retrieve query schemas. Declaration-only. */
import type * as z from "zod"

import type { FilterLimits } from "./filter.ts"
import type { LimitsGiven } from "./filter-validate.ts"
import type { RESERVED_LIST_KEYS, RESERVED_RETRIEVE_KEYS } from "./schema-params.ts"
import type { FieldType, FilterAST, ParsedFields, SortDirection, SortField } from "./types.ts"

/** The fields an endpoint's `select` may name; any other is a 400 naming it */
type FieldsConfig = {
	/** the relations `select` may embed as `name(...)`; omitted, none */
	relations?: readonly string[] | undefined
	/** each relation's selectable fields, which its `*` expands to; a relation with no entry selects none */
	relationFields?: Record<string, readonly string[]> | undefined
	/** the top-level fields, which `*` expands to; a `@`-prefixed computed field is always taken, for the handler to fill */
	scalars: readonly string[]
}

/**
 * A zod shape for `extend` whose every schema outputs the type it takes: the schema checks its parsed
 * output again, so a transform or a default would run on its own result
 */
type OutputStableShape<T extends z.ZodRawShape = z.ZodRawShape> = {
	[K in keyof T]: z.ZodType<z.infer<T[K]>, z.infer<T[K]>>
}

/** Bounds on one list request, each a whole number from 0, past which the request is a 400; `LIST_QUERY_LIMITS` holds the defaults */
type ListQueryLimits = FilterLimits & {
	/** the most characters `filter` holds, checked before it is parsed; default 2048 */
	maxFilterLength: number
	/** the most whitespace-separated words `q` holds; default 8 */
	maxSearchTerms: number
	/** the most keys one `order` holds, from 1; default 3 */
	maxSortKeys: number
}

/** A list's page sizes; createListQuerySchema throws a TypeError naming the key it cannot take */
type PaginationConfig = {
	/** the limit a request without `limit` gets, from 1 to maxLimit; default 20 */
	defaultLimit?: number | undefined
	/** the largest `limit` a request may send, a whole number from 1; default 100 */
	maxLimit?: number | undefined
	/** The last page offset pagination serves; past it, a client pages by cursor. Default 10 000. */
	maxPage?: number | undefined
}

/** A name the list query schema owns, as a param or in its output, which `extend` may not take */
export type ReservedListKey = (typeof RESERVED_LIST_KEYS)[number]

/** A name the retrieve query schema owns, which `extend` may not take */
export type ReservedRetrieveKey = (typeof RESERVED_RETRIEVE_KEYS)[number]

/** What createListQuerySchema builds a list endpoint's query schema from; each optional param exists only where declared, and any other param is a 400 */
type ListQueryConfig<
	T extends OutputStableShape<T> = Record<never, never>,
	TSortFields extends readonly string[] = readonly string[],
> = {
	/** Extra params, validated and returned as they are; a name the schema owns is refused */
	extend?: (T & { [K in ReservedListKey]?: never | undefined }) | undefined
	/** The fields `select` may name. Omitted: the endpoint takes no `select`. */
	fields?: FieldsConfig | undefined
	/** Fields `filter` may name. Omitted or empty: the endpoint takes no `filter`. */
	filter?: Record<string, FieldType> | undefined
	/** Accept `lang` (localized text). Omitted: the endpoint takes no `lang`. */
	lang?: true | undefined
	/** Bounds that replace the defaults in `LIST_QUERY_LIMITS`, each on its own */
	limits?: LimitsGiven<ListQueryLimits> | undefined
	/**
	 * Fields `q` searches, as published. Omitted: the endpoint takes no `q`.
	 * Declaring it obliges the handler to pass a search resolver to buildListQuery,
	 * which refuses a `q` it cannot apply.
	 */
	search?: readonly string[] | undefined
	/** Page sizes and the deepest page; omitted, the defaults in `PAGINATION_DEFAULTS` */
	pagination?: PaginationConfig | undefined
	/** The fields `order` may sort on, as published; an `order` naming any other is a 400 */
	sort: TSortFields
	// QL10 of r22b
	/**
	 * The column the list breaks ties on, published as `stableTiebreak`. Omitted: `id`, as
	 * buildListQuery breaks ties; a derived list names its `idColumn`'s.
	 */
	tiebreak?: string | undefined
}

/** What createRetrieveQuerySchema builds a single-resource endpoint's query schema from */
type RetrieveQueryConfig<T extends z.ZodRawShape = z.ZodRawShape> = {
	/** Extra params, validated and returned as they are; a name the schema owns is refused */
	extend?: (T & { [K in ReservedRetrieveKey]?: never | undefined }) | undefined
	/** The fields `select` may name */
	fields: FieldsConfig
	/** Accept `lang` (localized text). Omitted: the endpoint takes no `lang`. */
	lang?: true | undefined
}

/** A list query schema's parsed output, which every list builder takes as it is */
type ListQueryOutput<TSortField extends string = string> = {
	/** the `cursor` param as sent; it wins over `page` when both are */
	cursor: string | undefined
	/** the checked filter, each value typed as its field; null without a `filter` */
	filterAst: FilterAST | null
	/** the `lang` param as sent */
	lang: string | undefined
	/** the `limit` param, or the default limit when absent */
	limit: number
	/** the `page` param, a whole number from 1 to maxPage */
	page: number | undefined
	/** the checked `select`, `*` expanded to the declared fields; null without one, which selects every field */
	parsedFields: ParsedFields | null
	/** the `order` keys in order; empty without an `order` */
	parsedSort: Array<SortField<TSortField>>
	/** the `q` param as sent */
	q: string | undefined
	/** each sorted field's direction */
	sortOrderBy: Partial<Record<TSortField, SortDirection>>
	// C7 of r19, U29
	/**
	 * The schema's own maxPage, which holds the page wherever this object is read, a spread of it
	 * included. A query built by hand leaves it out for the default maxPage, or states the bound it means
	 */
	pageBound?: number | undefined
	// Q16 of r18, C7 of r19
	/** The schema's own maxLimit, which holds the limit as `pageBound` holds the page */
	limitBound?: number | undefined
	/** The column the schema says the list breaks ties on, `id` by default, which a derived list's idColumn names */
	tiebreak?: string | undefined
	/** Always true: the filter and the order were checked against the endpoint's fields */
	validated: true
}

/** A retrieve query schema's parsed output */
type RetrieveQueryOutput = {
	/** the `lang` param as sent */
	lang: string | undefined
	/** the checked `select`, `*` expanded to the declared fields; null without one, which selects every field */
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
