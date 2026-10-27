/**
 * The list query schema: validates `filter`, `order`, `cursor`, `page`, `limit` and the optional
 * params an endpoint declares, and returns them parsed, stamped with the facts it enforces.
 */
import * as z from "zod"

import { EMPTY_OBJ } from "../empty.ts"
import { filterParamMeta, orderParamMeta, searchParamMeta } from "./descriptions.ts"
import { OPERATORS_BY_TYPE } from "./filter.ts"
import { listQueryStamp } from "./list-meta.ts"
import { filterAstOf, parsedSortOf, reportOutputIssues, sortOrderByOf } from "./list-transform.ts"
import { encodedMessage, LIST_QUERY_LIMITS, PAGINATION_DEFAULTS, REQUEST_BYTES, withinBytes } from "./schema-limits.ts"
import {
	baseListQueryShape,
	filterAstSchema,
	langQueryField,
	assertNotReserved,
	limitSchemaFor,
	pageSchemaFor,
	parsedFieldsSchema,
	pickExtended,
	selectQueryField,
	sortDirectionEnum,
} from "./schema-params.ts"
import { pageTooDeep } from "./trusted.ts"
import type { ListQueryConfig, ListQueryLimits, ListQueryOutput, OutputStableShape } from "./schema-types.ts"
import { validateSelectWithConfig } from "./select-validate.ts"
import type { FieldType } from "./types.ts"

type AdvertisedConfig = Pick<ListQueryConfig, "fields" | "filter" | "lang" | "search" | "sort">

/** The optional params beside cursor, page and limit; each key exists only when advertised */
type OptionalShape = {
	order: z.ZodOptional<z.ZodString>
	filter?: z.ZodOptional<z.ZodString>
	q?: z.ZodOptional<z.ZodString>
	lang?: z.ZodOptional<z.ZodString>
	select?: z.ZodOptional<z.ZodString>
}

type ListQueryShape = typeof baseListQueryShape &
	OptionalShape & {
		limit: z.ZodDefault<z.ZodCoercedNumber<unknown>>
		page: z.ZodOptional<z.ZodCoercedNumber<unknown>>
	}

/* the params and output keys the schema owns; ReservedListKey in schema-types.ts is their type */
// lookup-table: the names an extension may not take
const RESERVED = /* @__PURE__ */ Object.freeze([
	"cursor",
	"filter",
	"filterAst",
	"lang",
	"limit",
	"order",
	"page",
	"parsedFields",
	"parsedSort",
	"q",
	"select",
	"sortOrderBy",
	"validated",
])
type ListQueryInput = z.ZodObject<ListQueryShape, z.core.$strict>

/** What createListQuerySchema returns: the strict request object piped into its parsed output */
type ListQuerySchema<T extends OutputStableShape<T>, TSortField extends string> = z.ZodPipe<
	ListQueryInput,
	z.ZodTransform<Awaited<ListQueryOutput<TSortField> & { [K in keyof T]: z.infer<T[K]> }>, z.output<ListQueryInput>>
>

/**
 * The params advertised beside cursor, page and limit. Each optional param exists only when the
 * endpoint honors it — a param the handler ignores answers every value with the unfiltered
 * list — and the object is strict, so a param that is not advertised is a 400.
 */
function optionalShapeFor(config: AdvertisedConfig, limits: ListQueryLimits): OptionalShape {
	const filterConfig: Record<string, FieldType> = config.filter ?? EMPTY_OBJ
	const search = config.search
	const filter = z
		.string()
		.max(limits.maxFilterLength)
		.refine(withinBytes(REQUEST_BYTES.filter), { message: encodedMessage(REQUEST_BYTES.filter) })
		.optional()
		.meta(filterParamMeta(filterConfig, (type) => OPERATORS_BY_TYPE[type], limits))
	const q = (terms: readonly string[]) =>
		z
			.string()
			.max(200)
			.refine(withinBytes(REQUEST_BYTES.q), { message: encodedMessage(REQUEST_BYTES.q) })
			.refine((value) => value.split(/\s+/u).filter(Boolean).length <= limits.maxSearchTerms, {
				message: `At most ${limits.maxSearchTerms} search terms`,
			})
			.optional()
			.meta(searchParamMeta(terms, limits.maxSearchTerms))
	return {
		order: z
			.string()
			.max(200)
			.refine(withinBytes(REQUEST_BYTES.order), { message: encodedMessage(REQUEST_BYTES.order) })
			.optional()
			.meta(orderParamMeta(config.sort, limits.maxSortKeys)),
		...(Object.keys(filterConfig).length > 0 ? { filter } : {}),
		...(search ? { q: q(search) } : {}),
		...(config.lang ? { lang: langQueryField } : {}),
		...(config.fields
			? {
					select: selectQueryField.refine((value) => value === undefined || withinBytes(REQUEST_BYTES.select)(value), {
						message: encodedMessage(REQUEST_BYTES.select),
					}),
				}
			: {}),
	}
}

/** What the transform returns, as a schema the pipe checks it against */
function outputSchemaFor(sortConfig: readonly string[], extendFields: Record<string, z.ZodType> | undefined) {
	const sortFieldSchema = z.enum(sortConfig as [string, ...string[]])
	return z.compile(
		z.object({
			cursor: z.string().optional(),
			filterAst: filterAstSchema.nullable(),
			lang: z.string().optional(),
			limit: z.number(),
			page: z.number().optional(),
			parsedFields: parsedFieldsSchema.nullable(),
			parsedSort: z
				.object({ direction: sortDirectionEnum, field: sortFieldSchema, nulls: z.enum(["first", "last"]).optional() })
				.array(),
			q: z.string().optional(),
			sortOrderBy: z.partialRecord(sortFieldSchema, sortDirectionEnum),
			pageBounded: z.literal(true),
			validated: z.literal(true),
			...extendFields,
		}),
	)
}

function createListQuerySchema<
	T extends OutputStableShape<T> = Record<string, never>,
	const TSortFields extends readonly string[] = readonly string[],
>(config: ListQueryConfig<T, TSortFields>): ListQuerySchema<T, TSortFields[number]> {
	type TSortField = TSortFields[number]
	type ExtendedOutput = ListQueryOutput<TSortField> & { [K in keyof T]: z.infer<T[K]> }
	const { extend: extendFields, fields: fieldsConfig, filter: filterConfig = EMPTY_OBJ, sort: sortConfig } = config
	const limits: ListQueryLimits = { ...LIST_QUERY_LIMITS, ...config.limits }
	const extensions = extendFields as Record<string, z.ZodType> | undefined
	assertNotReserved("createListQuerySchema", extensions, RESERVED)

	const shape = {
		...baseListQueryShape,
		...optionalShapeFor(config, limits),
		limit: limitSchemaFor(config.pagination),
		page: pageSchemaFor(config.pagination),
	}
	const schema = z.compile(extendFields ? z.strictObject({ ...shape, ...extendFields }) : z.strictObject(shape))
	const outputSchema = outputSchemaFor(sortConfig, extensions)

	const maxPage = config.pagination?.maxPage ?? PAGINATION_DEFAULTS.maxPage
	const piped = schema.transform((data, ctx): ExtendedOutput => {
		if (data.page !== undefined && data.page > maxPage) throw pageTooDeep(data.page, maxPage)
		/* Optional params exist on `data` only when advertised above. */
		const optional = data as { filter?: string; lang?: string; q?: string; select?: unknown }
		const filterAst = filterAstOf(optional.filter, { fields: filterConfig, limits }, ctx)
		const parsedSort = parsedSortOf<TSortField>(data.order, { maxSortKeys: limits.maxSortKeys, sort: sortConfig }, ctx)
		/* cursor takes precedence over page — both accepted gracefully */
		const select = typeof optional.select === "string" ? optional.select : undefined
		const output = {
			cursor: data.cursor,
			filterAst,
			lang: optional.lang,
			limit: data.limit,
			page: data.page,
			parsedFields: fieldsConfig ? validateSelectWithConfig(select, fieldsConfig, ctx) : null,
			parsedSort,
			q: optional.q,
			sortOrderBy: sortOrderByOf(parsedSort),
			pageBounded: true as const,
			validated: true as const,
			...(pickExtended(extensions, data) as { [K in keyof T]: z.infer<T[K]> }),
		}
		reportOutputIssues(outputSchema, output, ctx)
		return output
	})
	const withPipe: typeof piped = piped.pipe(outputSchema as never) as {} as typeof piped

	/* Stamp the schema we RETURN. Metadata on `schema` or `piped` survives the
	   input view but is lost on the output view — see docs/meta-contract.md §3.1. */
	return withPipe.meta(listQueryStamp(config, limits)) as {} as ListQuerySchema<T, TSortField>
}

export { createListQuerySchema, type ListQuerySchema }
