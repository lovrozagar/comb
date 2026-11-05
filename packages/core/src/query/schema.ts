/**
 * Zod schema builders for list/retrieve query validation, and the response meta schema.
 * Combines filter, sort, fields, and pagination into validated schemas.
 */
import * as z from "zod"

/** The zod schema of a list response's `pagination` */
export type PaginationResponseSchema = z.ZodObject<
	{
		/** rows the filter matches across all pages; null on a cursor page, or a page past the end of one database */
		count: z.ZodNullable<z.ZodNumber>
		/** true when a next page exists */
		hasMore: z.ZodBoolean
		/** the page size the request read with */
		limit: z.ZodNumber
		/** the cursor of the next page; null on the last page, or a list no cursor can resume */
		nextCursor: z.ZodNullable<z.ZodString>
		/** the page number; null on a cursor page */
		page: z.ZodNullable<z.ZodNumber>
	},
	z.core.$strip
>

/** The pagination meta a list response carries */
function paginationResponse(): PaginationResponseSchema {
	return z.object({
		/* rows the filter matches across all pages; null when the response cannot know (cursor pages) */
		count: z.number().int().min(0).nullable(),
		hasMore: z.boolean(),
		limit: z.number().int().min(1),
		nextCursor: z.string().nullable(),
		page: z.number().int().min(1).nullable(),
	})
}

/** Pagination response meta schema for list endpoints */
const paginationResponseSchema: PaginationResponseSchema = /* @__PURE__ */ paginationResponse()

/* the schemas' own types, which a module exporting one names in its declarations (K11 of r17) */
export { createListQuerySchema, type ListQuerySchema } from "./list-schema.ts"
export { createRetrieveQuerySchema, type RetrieveQuerySchema } from "./retrieve-schema.ts"
export { LIST_QUERY_LIMITS, PAGINATION_DEFAULTS } from "./schema-limits.ts"
export type {
	FieldsConfig,
	ListQueryConfig,
	ListQueryLimits,
	ListQueryOutput,
	RetrieveQueryConfig,
	RetrieveQueryOutput,
} from "./schema-types.ts"
export { paginationResponseSchema }
