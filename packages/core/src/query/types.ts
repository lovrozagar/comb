/**
 * Query helper types — DB-agnostic.
 * Shared by parsers, validators, and DB-specific SQL generators.
 */
import type { SQL } from "drizzle-orm"

type FieldSelection = {
	relations: Record<string, FieldSelection | null>
	scalars: string[]
}

type ParsedFields = {
	root: FieldSelection
}

type FilterOperator =
	| "eq"
	| "ne"
	| "neq"
	| "gt"
	| "gte"
	| "lt"
	| "lte"
	| "in"
	| "nin"
	| "like"
	| "ilike"
	| "is"
	/** Parsed for callers that validate and run it themselves (JSON-array membership); comb's own validator and SQL take none */
	| "contains"

type FieldType = "string" | "number" | "boolean" | "date" | "enum"

type FilterCondition = {
	field: string
	operator: FilterOperator
	value: unknown
}

type FilterGroup = {
	conditions: FilterCondition[]
	logic: "and" | "or"
	subgroups: FilterGroup[]
}

type FilterAST = {
	root: FilterGroup
}

type SortDirection = "asc" | "desc"
type SortNulls = "first" | "last"

type SortField<T extends string = string> = {
	direction: SortDirection
	field: T
	nulls?: SortNulls | undefined
}

/**
 * What every list builder takes (buildListQuery, buildDerivedListQuery, queryHelpers.listOptions):
 * the list schema's output, or a query the app builds itself, its arrays read only (K10 of r17)
 */
type ListQueryInput<TSortField extends string = string> = {
	/* `| undefined` on each optional field: the list schema's output carries them as undefined, which
	   exactOptionalPropertyTypes otherwise refuses */
	cursor?: string | null | undefined
	filterAst?: FilterAST | null | undefined
	limit: number
	page?: number | null | undefined
	/** the schema's own page was checked against its maxPage (query/trusted.ts); absent, the default bounds it */
	pageBounded?: true | undefined
	parsedFields?: ParsedFields | null | undefined
	parsedSort: readonly SortField<TSortField>[]
	q?: string | null | undefined
	/** The list schema sets it; a filter or an order without it is refused (query/trusted.ts) */
	validated?: true | undefined
}

type ComputedFilterResolver = (operator: FilterOperator, value: unknown) => SQL | null
type ComputedSortResolver = (direction: SortDirection) => SQL

type ListQueryCapabilities = {
	computedFilterFields: Record<string, FieldType>
	computedSortFields: Set<string>
	filterFields: Record<string, FieldType>
	pagination: {
		defaultLimit: number
		maxLimit: number
	}
	relationFilterFields: Record<string, FieldType>
	searchFields: Set<string>
	sortFields: Set<string>
}

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
}
