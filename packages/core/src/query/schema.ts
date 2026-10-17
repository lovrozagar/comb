/**
 * Zod schema builders for list/retrieve query validation, and the response meta schema.
 * Combines filter, sort, fields, and pagination into validated schemas.
 */
import * as z from "zod"

/** The pagination meta a list response carries */
function paginationResponse() {
	return z.compile(
		z.object({
			/* rows the filter matches across all pages; null when the response cannot know (cursor pages) */
			count: z.number().int().min(0).nullable(),
			hasMore: z.boolean(),
			limit: z.number().int().min(1),
			nextCursor: z.string().nullable(),
			page: z.number().int().min(1).nullable(),
		}),
	)
}

/** Pagination response meta schema for list endpoints */
const paginationResponseSchema = /* @__PURE__ */ paginationResponse()

export { defineListQuery, listQueryBaseSchema, type ListQueryDefinition } from "./define-list-query.ts"
export { createListQuerySchema } from "./list-schema.ts"
export { createRetrieveQuerySchema } from "./retrieve-schema.ts"
export { LIST_QUERY_LIMITS, PAGINATION_DEFAULTS } from "./schema-limits.ts"
export type {
	FieldsConfig,
	ListQueryConfig,
	ListQueryLimits,
	ListQueryOutput,
	ListQuerySchemaConfig,
	RetrieveQueryConfig,
	RetrieveQueryOutput,
} from "./schema-types.ts"
export { paginationResponseSchema }
