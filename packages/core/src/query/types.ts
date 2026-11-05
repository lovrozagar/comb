/**
 * Query helper types — DB-agnostic.
 * Shared by parsers, validators, and DB-specific SQL generators.
 */
import type { SQL } from "drizzle-orm"

/** The fields one level of a `select` names, as `parseSelect` reads it */
type FieldSelection = {
	/** each relation embedded as `name(...)`, by name, with what it selects; null selects every field of it */
	relations: Record<string, FieldSelection | null>
	/** the field names at this level, each once, in the order written; `*` stands for every field, a leading `@` for a computed one */
	scalars: string[]
}

/** A parsed `select`; `filterBySelect` projects a row by it */
type ParsedFields = {
	/** what the top level selects */
	root: FieldSelection
}

/**
 * A filter condition's operator, as written between the field and the value: `ne` and `neq` both
 * mean not equal, `in` and `nin` take a parenthesized list, `like` is case-sensitive and `ilike`
 * ignores ASCII case (both with `*` as the wildcard), and `is` takes `null`, `notnull`, `true` or `false`
 */
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

/** A filterable field's type, which decides the operators it takes and how its value is read: a `date` as epoch milliseconds unless its spec says `iso` */
type FieldType = "string" | "number" | "boolean" | "date" | "enum"

/** One `field.operator.value` term of a filter */
type FilterCondition = {
	/** the field as written: a column, `relation.column`, or a `@`-prefixed computed field */
	field: string
	/** the operator as written; `ne` and `neq` are one */
	operator: FilterOperator
	/** the value as parsed: a string, null for `is.null`, or an array of strings for a list; `validateFilter` types it as its field */
	value: unknown
}

/** Conditions and nested groups joined by one logic */
type FilterGroup = {
	/** the group's own terms, in the order written */
	conditions: FilterCondition[]
	/** how the group's conditions and subgroups combine; the top level is `and` */
	logic: "and" | "or"
	/** each nested `and(...)` or `or(...)`, in the order written */
	subgroups: FilterGroup[]
}

/** A parsed filter, as `parseFilter` and `validateFilter` return it */
type FilterAST = {
	/** the top-level group, joined by its own `logic`; `parseFilter` and `validateFilter` make it an `and` */
	root: FilterGroup
}

/** A sort key's direction */
type SortDirection = "asc" | "desc"
/** Where a sort key puts nulls; left out, they sort last ascending and first descending, as on Postgres */
type SortNulls = "first" | "last"

/** One key of an `order`, as `parseOrder` returns it */
type SortField<T extends string = string> = {
	/** the direction as written; `asc` when the key names none */
	direction: SortDirection
	/** the field sorted on: a column, or a `@`-prefixed computed field */
	field: T
	/** null placement as written; left out, the direction decides it (see SortNulls) */
	nulls?: SortNulls | undefined
}

// K10 of r17: the builders read its arrays only
/**
 * What every list builder takes (buildListQuery, buildDerivedListQuery, queryHelpers.listOptions):
 * the list schema's output, or a query the app builds itself. The builders never change its arrays
 */
type ListQueryInput<TSortField extends string = string> = {
	/* `| undefined` on each optional field: the list schema's output carries them as undefined, which
	   exactOptionalPropertyTypes otherwise refuses */
	/** the previous page's next cursor, to read the page after it; null or absent reads the first page */
	cursor?: string | null | undefined
	/** the parsed filter; null or absent filters nothing */
	filterAst?: FilterAST | null | undefined
	/** the most rows the page holds, a whole number from 1 */
	limit: number
	/** the 1-based page to read by number; null or absent is page 1. A cursor, when given, wins */
	page?: number | null | undefined
	/** the deepest page this query may read; absent, the default maxPage. A deeper page is a 400 */
	pageBound?: number | undefined
	// Q16 of r18
	/** the largest limit this query may take; absent, the default maxLimit. A larger limit is a 400 */
	limitBound?: number | undefined
	/** the column the list schema breaks ties on; a derived list's idColumn must name it */
	tiebreak?: string | undefined
	/** the parsed `select`; null or absent selects every field */
	parsedFields?: ParsedFields | null | undefined
	/** the sort keys in order; empty sorts by the tiebreak column alone */
	parsedSort: readonly SortField<TSortField>[]
	/** the search text, trimmed; null, absent or blank searches nothing */
	q?: string | null | undefined
	/**
	 * The list schema sets it. A builder throws a 500 on a filter or an order without it, as neither
	 * was checked against the fields the endpoint declares; set it only on ones your code checked
	 */
	validated?: true | undefined
}

/** Lowers a computed filter field's condition to SQL; null when it does not take the operator, which the builder answers with a 500 */
type ComputedFilterResolver = (operator: FilterOperator, value: unknown) => SQL | null
/** The ORDER BY term of a computed sort field in `direction`; a list sorted on one pages by number, and a cursor on it is a 400 */
type ComputedSortResolver = (direction: SortDirection) => SQL

export type {
	ComputedFilterResolver,
	ComputedSortResolver,
	FieldSelection,
	FieldType,
	FilterAST,
	FilterCondition,
	FilterGroup,
	FilterOperator,
	ListQueryInput,
	ParsedFields,
	SortDirection,
	SortField,
	SortNulls,
}
