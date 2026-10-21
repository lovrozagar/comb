/** The configs and outputs of the list and retrieve query schemas. Declaration-only. */
import type * as z from "zod"

import type { FilterLimits } from "./filter.ts"
import type { FieldType, FilterAST, ParsedFields, SortDirection, SortField } from "./types.ts"

type FieldsConfig = {
	relations?: readonly string[]
	relationFields?: Record<string, readonly string[]>
	scalars: readonly string[]
}

type OutputStableShape<T extends z.ZodRawShape = z.ZodRawShape> = {
	[K in keyof T]: z.ZodType<z.infer<T[K]>, z.infer<T[K]>>
}

/** Bounds on one list request; `maxFilterLength` is checked before the filter is parsed */
type ListQueryLimits = FilterLimits & { maxFilterLength: number; maxSearchTerms: number; maxSortKeys: number }

type PaginationConfig = {
	defaultLimit?: number
	maxLimit?: number
	/** The last page offset pagination serves; past it, a client pages by cursor. Default 10 000. */
	maxPage?: number
}

/* the params and output keys a list query schema owns: an extension under one would replace a checked value */
type ReservedListKey =
	| "cursor"
	| "filter"
	| "filterAst"
	| "lang"
	| "limit"
	| "order"
	| "page"
	| "parsedFields"
	| "parsedSort"
	| "q"
	| "select"
	| "sortOrderBy"
	| "validated"

/* the same for a retrieve query schema */
type ReservedRetrieveKey = "lang" | "parsedFields" | "select"

type ListQueryConfig<
	T extends OutputStableShape<T> = Record<string, never>,
	TSortFields extends readonly string[] = readonly string[],
> = {
	/** Extra params, validated and returned as they are; a name the schema owns is refused */
	extend?: T & { [K in ReservedListKey]?: never }
	fields?: FieldsConfig
	/** Fields `filter` may name. Omitted or empty: the endpoint takes no `filter`. */
	filter?: Record<string, FieldType>
	/** Accept `lang` (localized text). Omitted: the endpoint takes no `lang`. */
	lang?: true
	limits?: Partial<ListQueryLimits>
	/**
	 * Fields `q` searches, as published. Omitted: the endpoint takes no `q`.
	 * Declaring it obliges the handler to pass a search resolver to buildListQuery,
	 * which refuses a `q` it cannot apply.
	 */
	search?: readonly string[]
	pagination?: PaginationConfig
	sort: TSortFields
}

type RetrieveQueryConfig<T extends z.ZodRawShape = z.ZodRawShape> = {
	/** Extra params, validated and returned as they are; a name the schema owns is refused */
	extend?: T & { [K in ReservedRetrieveKey]?: never }
	fields: FieldsConfig
	/** Accept `lang` (localized text). Omitted: the endpoint takes no `lang`. */
	lang?: true
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
