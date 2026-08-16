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

type ListQueryInput = {
	cursor?: string | null
	filter?: string | null
	limit?: number | null
	order?: string | null
	page?: number | null
	q?: string | null
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
