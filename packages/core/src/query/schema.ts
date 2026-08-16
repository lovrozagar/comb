/**
 * Zod schema builders for list/retrieve query validation.
 * Combines filter, sort, fields, and pagination into validated schemas.
 */
import * as z from "zod"

import { COMB_FILTER_GRAMMAR, combMeta } from "../meta.ts"
import { EMPTY_ARR, EMPTY_OBJ } from "../types.ts"
import { CURSOR_TIEBREAK_COLUMN } from "./cursor.ts"
import { parseSelect } from "./fields.ts"
import { parseOrder, validateFilter } from "./filter.ts"
import {
	CURSOR_DESCRIPTION,
	CURSOR_EXAMPLES,
	FILTER_DESCRIPTION,
	FILTER_EXAMPLES,
	LANG_DESCRIPTION,
	LANG_EXAMPLES,
	LIMIT_DESCRIPTION,
	LIMIT_EXAMPLES,
	ORDER_DESCRIPTION,
	ORDER_EXAMPLES,
	PAGE_DESCRIPTION,
	PAGE_EXAMPLES,
	Q_DESCRIPTION,
	Q_EXAMPLES,
	SELECT_DESCRIPTION,
	SELECT_EXAMPLES,
} from "./descriptions.ts"
import type {
	FieldSelection,
	FieldType,
	FilterAST,
	FilterGroup,
	ListQueryCapabilities,
	ParsedFields,
	SortDirection,
	SortField,
} from "./types.ts"

const PAGINATION_DEFAULTS = {
	defaultLimit: 20,
	maxLimit: 100,
} as const

/** Pagination response meta schema for list endpoints */
const paginationResponseSchema = z.object({
	count: z.number().int().min(0),
	hasMore: z.boolean(),
	limit: z.number().int().min(1),
	nextCursor: z.string().nullable(),
	page: z.number().int().min(1).nullable(),
})

type FieldsConfig = {
	relations?: readonly string[]
	relationFields?: Record<string, readonly string[]>
	scalars: readonly string[]
}

type OutputStableShape<T extends z.ZodRawShape = z.ZodRawShape> = {
	[K in keyof T]: z.ZodType<z.infer<T[K]>, z.infer<T[K]>>
}

type ListQueryConfig<
	T extends OutputStableShape<T> = Record<string, never>,
	TSortFields extends readonly string[] = readonly string[],
> = {
	extend?: T
	fields?: FieldsConfig
	filter?: Record<string, FieldType>
	pagination?: {
		defaultLimit?: number
		maxLimit?: number
	}
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

type ListQuerySchemaConfig = {
	computedFilter?: Record<string, FieldType>
	computedSort?: readonly string[]
	filter?: Record<string, FieldType>
	pagination?: {
		defaultLimit?: number
		maxLimit?: number
	}
	relationFilter?: Record<string, FieldType>
	search?: readonly string[]
	sort?: readonly string[]
}

function validateSelectWithConfig(
	selectString: string | undefined,
	fieldsConfig: FieldsConfig,
	ctx: z.RefinementCtx,
): ParsedFields | null {
	if (!selectString || selectString.trim() === "") {
		return null
	}

	const parsed = parseSelect(selectString)
	if (!parsed) {
		ctx.addIssue({
			code: "custom",
			message: "Invalid select syntax",
			path: ["select"],
		})
		return null
	}

	const scalarSet = new Set(fieldsConfig.scalars)
	const relationSet = new Set(fieldsConfig.relations ?? [])
	const relationFieldSets: Record<string, Set<string>> = {}
	for (const [rel, fields] of Object.entries(fieldsConfig.relationFields ?? {})) {
		relationFieldSets[rel] = new Set(fields)
	}

	/* Handle * wildcard at top level — expand to all scalars */
	if (parsed.root.scalars.includes("*")) {
		parsed.root.scalars = [...fieldsConfig.scalars]
	}

	for (const field of parsed.root.scalars) {
		if (!scalarSet.has(field) && !field.startsWith("@")) {
			ctx.addIssue({
				code: "custom",
				message: `Unknown field: ${field}`,
				path: ["select"],
			})
		}
	}

	for (const [relationName, selection] of Object.entries(parsed.root.relations)) {
		if (!relationSet.has(relationName)) {
			ctx.addIssue({
				code: "custom",
				message: `Unknown relation: ${relationName}`,
				path: ["select"],
			})
			continue
		}

		if (selection === null) continue

		const allowedFields = relationFieldSets[relationName]

		/* expand nested wildcard to all allowed fields */
		if (selection.scalars.includes("*") && allowedFields) {
			selection.scalars = [...allowedFields]
		}

		if (allowedFields) {
			for (const field of selection.scalars) {
				if (!allowedFields.has(field) && !field.startsWith("@")) {
					ctx.addIssue({
						code: "custom",
						message: `Unknown ${relationName} field: ${field}`,
						path: ["select"],
					})
				}
			}
		}
	}

	return parsed
}

const selectQueryField = z.string().max(500).optional().meta({
	description: SELECT_DESCRIPTION,
	examples: SELECT_EXAMPLES,
})

const baseRetrieveShape = {
	lang: z.string().min(2).max(10).optional().meta({
		description: LANG_DESCRIPTION,
		examples: LANG_EXAMPLES,
	}),
	select: selectQueryField,
}

const baseRetrieveSchema = z.object(baseRetrieveShape)

function createRetrieveQuerySchema<T extends z.ZodRawShape = Record<string, never>>(config: RetrieveQueryConfig<T>) {
	const { extend: extendFields, fields: fieldsConfig } = config

	const schema = extendFields ? z.object({ ...baseRetrieveShape, ...extendFields }) : baseRetrieveSchema

	type ExtendedOutput = RetrieveQueryOutput & {
		[K in keyof T]: z.infer<T[K]>
	}

	return schema.transform((data, ctx): ExtendedOutput => {
		const parsedFields = validateSelectWithConfig(data.select, fieldsConfig, ctx)

		const extendedValues = extendFields
			? (Object.fromEntries(Object.keys(extendFields).map((key) => [key, data[key as keyof typeof data]])) as {
					[K in keyof T]: z.infer<T[K]>
				})
			: ({} as { [K in keyof T]: z.infer<T[K]> })

		return {
			lang: data.lang,
			parsedFields,
			...extendedValues,
		}
	})
}

const baseListQueryShape = {
	cursor: z.string().optional().meta({
		description: CURSOR_DESCRIPTION,
		examples: CURSOR_EXAMPLES,
	}),
	filter: z.string().optional().meta({
		description: FILTER_DESCRIPTION,
		examples: FILTER_EXAMPLES,
	}),
	lang: z.string().min(2).max(10).optional().meta({
		description: LANG_DESCRIPTION,
		examples: LANG_EXAMPLES,
	}),
	order: z.string().optional().meta({
		description: ORDER_DESCRIPTION,
		examples: ORDER_EXAMPLES,
	}),
	page: z.coerce.number().int().min(1).optional().meta({
		description: PAGE_DESCRIPTION,
		examples: PAGE_EXAMPLES,
	}),
	q: z.string().max(200).optional().meta({
		description: Q_DESCRIPTION,
		examples: Q_EXAMPLES,
	}),
}

const fieldSelectionSchema: z.ZodType<FieldSelection, FieldSelection> = z.lazy(() =>
	z.object({
		relations: z.record(z.string(), fieldSelectionSchema.nullable()),
		scalars: z.array(z.string()),
	}),
)

const parsedFieldsSchema: z.ZodType<ParsedFields, ParsedFields> = z.object({
	root: fieldSelectionSchema,
})

const filterGroupSchema: z.ZodType<FilterGroup, FilterGroup> = z.lazy(() =>
	z.object({
		conditions: z.array(
			z.object({
				field: z.string(),
				operator: z.enum(["contains", "eq", "gt", "gte", "ilike", "in", "is", "like", "lt", "lte", "ne", "neq", "nin"]),
				value: z.unknown(),
			}),
		),
		logic: z.enum(["and", "or"]),
		subgroups: z.array(filterGroupSchema),
	}),
)

const filterAstSchema: z.ZodType<FilterAST, FilterAST> = z.object({
	root: filterGroupSchema,
})

const sortDirectionEnum = z.enum(["asc", "desc"])

const defaultLimitSchema = z.coerce
	.number()
	.int()
	.min(1)
	.max(PAGINATION_DEFAULTS.maxLimit)
	.default(PAGINATION_DEFAULTS.defaultLimit)
	.meta({
		description: LIMIT_DESCRIPTION,
		examples: LIMIT_EXAMPLES,
	})

function createListQuerySchema<
	T extends OutputStableShape<T> = Record<string, never>,
	const TSortFields extends readonly string[] = readonly string[],
>(config: ListQueryConfig<T, TSortFields>) {
	type TSortField = TSortFields[number]
	const {
		extend: extendFields,
		fields: fieldsConfig,
		filter: filterConfig = EMPTY_OBJ,
		pagination = EMPTY_OBJ,
		sort: sortConfig,
	} = config

	const defaultLimit = pagination.defaultLimit ?? PAGINATION_DEFAULTS.defaultLimit
	const maxLimit = pagination.maxLimit ?? PAGINATION_DEFAULTS.maxLimit
	const sortSet = new Set(sortConfig)

	const isDefaultPagination =
		defaultLimit === PAGINATION_DEFAULTS.defaultLimit && maxLimit === PAGINATION_DEFAULTS.maxLimit
	const limitSchema = isDefaultPagination
		? defaultLimitSchema
		: z.coerce.number().int().min(1).max(maxLimit).default(defaultLimit).meta({
				description: LIMIT_DESCRIPTION,
				examples: LIMIT_EXAMPLES,
			})

	/* Advertised only when `fields` is set — otherwise oat sees a param
	   that parsedFields can never honor. */
	const selectShape = fieldsConfig ? { select: selectQueryField } : {}

	const schema = extendFields
		? z.object({ ...baseListQueryShape, ...selectShape, limit: limitSchema, ...extendFields })
		: z.object({ ...baseListQueryShape, ...selectShape, limit: limitSchema })

	type ExtendedOutput = ListQueryOutput<TSortField> & {
		[K in keyof T]: z.infer<T[K]>
	}

	const sortFieldSchema = z.enum(sortConfig)
	type OutputShape = T & {
		cursor: z.ZodType<string | undefined, string | undefined>
		filterAst: z.ZodType<FilterAST | null, FilterAST | null>
		lang: z.ZodType<string | undefined, string | undefined>
		limit: z.ZodType<number, number>
		page: z.ZodType<number | undefined, number | undefined>
		parsedFields: z.ZodType<ParsedFields | null, ParsedFields | null>
		parsedSort: z.ZodType<Array<SortField<TSortField>>, Array<SortField<TSortField>>>
		q: z.ZodType<string | undefined, string | undefined>
		sortOrderBy: z.ZodType<Partial<Record<TSortField, SortDirection>>, Partial<Record<TSortField, SortDirection>>>
	}
	const outputBaseShape = {
		cursor: z.string().optional(),
		filterAst: filterAstSchema.nullable(),
		lang: z.string().optional(),
		limit: z.number(),
		page: z.number().optional(),
		parsedFields: parsedFieldsSchema.nullable(),
		parsedSort: z
			.object({
				direction: sortDirectionEnum,
				field: sortFieldSchema,
				nulls: z.enum(["first", "last"]).optional(),
			})
			.array(),
		q: z.string().optional(),
		sortOrderBy: z.partialRecord(sortFieldSchema, sortDirectionEnum),
	} satisfies z.ZodRawShape

	const outputExtensions = (extendFields ?? {}) as T
	const outputShape: OutputShape = {
		...outputBaseShape,
		...outputExtensions,
	}
	const outputSchema = z.object(outputShape)

	const piped = schema.transform((data, ctx): ExtendedOutput => {
		let filterAst: FilterAST | null = null
		if (data.filter) {
			const filterResult = validateFilter(data.filter, filterConfig)
			if (filterResult && !filterResult.valid) {
				ctx.addIssue({
					code: "custom",
					message: filterResult.errors.join("; "),
					path: ["filter"],
				})
			} else if (filterResult?.valid) {
				filterAst = filterResult.ast
			}
		}

		const rawSort = parseOrder(data.order)
		const parsedSort: Array<SortField<TSortField>> = []

		for (const { direction, field, nulls } of rawSort) {
			if (!sortSet.has(field)) {
				ctx.addIssue({ code: "custom", message: `Unknown sort field: ${field}`, path: ["order"] })
			} else {
				const entry: SortField<TSortField> = { direction, field: field as TSortField }
				if (nulls) entry.nulls = nulls
				parsedSort.push(entry)
			}
		}

		if (parsedSort.length === 0) {
			const defaultField = sortConfig[0]
			if (defaultField) {
				parsedSort.push({ direction: "desc", field: defaultField })
			}
		}

		const sortOrderBy = {} as Record<TSortField, SortDirection>
		for (const sort of parsedSort) {
			sortOrderBy[sort.field] = sort.direction
		}

		const selectValue = "select" in data && typeof data.select === "string" ? data.select : undefined
		const parsedFields = fieldsConfig ? validateSelectWithConfig(selectValue, fieldsConfig, ctx) : null

		/* cursor takes precedence over page — both accepted gracefully */

		const extendedValues = extendFields
			? (Object.fromEntries(Object.keys(extendFields).map((key) => [key, data[key as keyof typeof data]])) as {
					[K in keyof T]: z.infer<T[K]>
				})
			: ({} as { [K in keyof T]: z.infer<T[K]> })

		const output = {
			cursor: data.cursor,
			filterAst,
			lang: data.lang,
			limit: data.limit,
			page: data.page,
			parsedFields,
			parsedSort,
			q: data.q,
			sortOrderBy,
			...extendedValues,
		}

		const result = outputSchema.safeParse(output)
		if (!result.success) {
			for (const issue of result.error.issues) {
				ctx.addIssue({
					code: "custom",
					message: issue.message,
					path: issue.path,
				})
			}
		}

		return output
	})
	const withPipe: typeof piped = piped.pipe(outputSchema as never) as {} as typeof piped

	/* Stamp the schema we RETURN. Metadata on `schema` or `piped` survives the
	   input view but is lost on the output view — see docs/meta-contract.md §3.1.
	   Every value below comes from `config`, the same object that parses the
	   request above, so the published facts cannot drift from behavior. */
	const stamped = withPipe.meta(
		combMeta({
			defaultOrder: buildDefaultOrder(sortConfig),
			filterable: Object.keys(filterConfig),
			grammar: COMB_FILTER_GRAMMAR,
			kind: "query",
			maxLimit,
			/* Not knowable here: `q` is resolved at buildListQuery, a different
			   call site. Declaring it would be unvalidated. See docs §6.1. */
			searchable: null,
			selectable: selectableFrom(fieldsConfig),
			sortable: [...sortConfig],
			stableTiebreak: CURSOR_TIEBREAK_COLUMN,
		}),
	) as typeof piped

	return stamped
}

/**
 * The order applied when a request names none. Mirrors the transform above:
 * first declared sort field, descending.
 */
function buildDefaultOrder(sortConfig: readonly string[]): string {
	const first = sortConfig[0]
	return first ? `${first}.desc` : ""
}

/**
 * Fields a consumer may name directly in `select`.
 *
 * Scalars only. A relation is selectable exclusively in the `author(name)`
 * form — the bare name parses as a scalar and is rejected — so publishing
 * relation names here would invite a consumer to send `select=author` and take
 * the 400 as a finding.
 */
function selectableFrom(fieldsConfig: FieldsConfig | undefined): string[] {
	if (!fieldsConfig) return []
	return [...fieldsConfig.scalars]
}

const listQueryBaseSchema = z.object({
	cursor: z.string().nullish(),
	filter: z.string().nullish(),
	limit: z.coerce.number().int().min(1).nullish(),
	order: z.string().nullish(),
	page: z.coerce.number().int().min(1).nullish(),
	q: z.string().nullish(),
	select: z.string().nullish(),
})

type ListQueryDefinition = {
	capabilities: ListQueryCapabilities
	schema: typeof listQueryBaseSchema
}

function defineListQuery(config: ListQuerySchemaConfig): ListQueryDefinition {
	const {
		computedFilter = EMPTY_OBJ,
		computedSort = EMPTY_ARR,
		filter = EMPTY_OBJ,
		pagination = EMPTY_OBJ,
		relationFilter = EMPTY_OBJ,
		search = EMPTY_ARR,
		sort = EMPTY_ARR,
	} = config

	const capabilities: ListQueryCapabilities = {
		computedFilterFields: { ...computedFilter },
		computedSortFields: new Set(computedSort),
		filterFields: { ...filter },
		pagination: {
			defaultLimit: pagination.defaultLimit ?? PAGINATION_DEFAULTS.defaultLimit,
			maxLimit: pagination.maxLimit ?? PAGINATION_DEFAULTS.maxLimit,
		},
		relationFilterFields: { ...relationFilter },
		searchFields: new Set(search),
		sortFields: new Set(sort),
	}

	return { capabilities, schema: listQueryBaseSchema }
}

export {
	createListQuerySchema,
	createRetrieveQuerySchema,
	defineListQuery,
	listQueryBaseSchema,
	PAGINATION_DEFAULTS,
	paginationResponseSchema,
	type FieldsConfig,
	type ListQueryConfig,
	type ListQueryDefinition,
	type ListQueryOutput,
	type ListQuerySchemaConfig,
	type RetrieveQueryConfig,
	type RetrieveQueryOutput,
}
