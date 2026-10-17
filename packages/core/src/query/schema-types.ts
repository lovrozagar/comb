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
}

type ListQueryConfig<
	T extends OutputStableShape<T> = Record<string, never>,
	TSortFields extends readonly string[] = readonly string[],
> = {
	extend?: T
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
	extend?: T
	fields: FieldsConfig
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
