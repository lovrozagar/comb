/**
 * A bare capabilities descriptor and a permissive base schema, for callers that validate the
 * list request elsewhere.
 */
import * as z from "zod"

import { EMPTY_ARR, EMPTY_OBJ } from "../empty.ts"
import { PAGINATION_DEFAULTS } from "./schema-limits.ts"
import type { ListQuerySchemaConfig } from "./schema-types.ts"
import type { ListQueryCapabilities } from "./types.ts"

/** Every list param as optional and nullable, `limit` and `page` coerced */
function permissiveListQuery() {
	return z.object({
		cursor: z.string().nullish(),
		filter: z.string().nullish(),
		limit: z.coerce.number().int().min(1).nullish(),
		order: z.string().nullish(),
		page: z.coerce.number().int().min(1).nullish(),
		q: z.string().nullish(),
		select: z.string().nullish(),
	})
}

const listQueryBaseSchema = /* @__PURE__ */ permissiveListQuery()

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

export { defineListQuery, listQueryBaseSchema, type ListQueryDefinition }
