/** The zod pieces the list and retrieve query schemas share: request params and parsed outputs. */
import * as z from "zod"
import { MAX_CURSOR_LENGTH } from "./cursor.ts"

import {
	CURSOR_DESCRIPTION,
	CURSOR_EXAMPLES,
	LANG_DESCRIPTION,
	LANG_EXAMPLES,
	LIMIT_DESCRIPTION,
	LIMIT_EXAMPLES,
	PAGE_DESCRIPTION,
	PAGE_EXAMPLES,
	SELECT_DESCRIPTION,
	SELECT_EXAMPLES,
} from "./descriptions.ts"
import { FILTER_OPERATORS } from "./filter-parse.ts"
import { PAGINATION_DEFAULTS } from "./schema-limits.ts"
import type { PaginationConfig } from "./schema-types.ts"
import type { FieldSelection, FilterAST, FilterGroup, ParsedFields } from "./types.ts"

const selectQueryField: z.ZodOptional<z.ZodString> = /* @__PURE__ */ z.string().max(500).optional().meta({
	description: SELECT_DESCRIPTION,
	examples: SELECT_EXAMPLES,
})

const langQueryField: z.ZodOptional<z.ZodString> = /* @__PURE__ */ z.string().min(2).max(10).optional().meta({
	description: LANG_DESCRIPTION,
	examples: LANG_EXAMPLES,
})

const baseListQueryShape: { cursor: z.ZodOptional<z.ZodString>; page: z.ZodOptional<z.ZodCoercedNumber<unknown>> } = {
	/* a cursor carries its sort values, so it is as long as they are; past this it is not one comb minted for a list */
	cursor: /* @__PURE__ */ z.string().max(MAX_CURSOR_LENGTH).optional().meta({
		description: CURSOR_DESCRIPTION,
		examples: CURSOR_EXAMPLES,
	}),
	page: /* @__PURE__ */ z.coerce.number().int().min(1).optional().meta({
		description: PAGE_DESCRIPTION,
		examples: PAGE_EXAMPLES,
	}),
}

const fieldSelectionSchema: z.ZodType<FieldSelection, FieldSelection> = /* @__PURE__ */ z.lazy(() =>
	z.object({
		relations: z.record(z.string(), fieldSelectionSchema.nullable()),
		scalars: z.array(z.string()),
	}),
)

const parsedFieldsSchema: z.ZodType<ParsedFields, ParsedFields> = /* @__PURE__ */ z.object({
	root: fieldSelectionSchema,
})

const filterGroupSchema: z.ZodType<FilterGroup, FilterGroup> = /* @__PURE__ */ z.lazy(() =>
	z.object({
		conditions: z.array(
			z.object({
				field: z.string(),
				operator: z.enum(FILTER_OPERATORS),
				value: z.unknown(),
			}),
		),
		logic: z.enum(["and", "or"]),
		subgroups: z.array(filterGroupSchema),
	}),
)

const filterAstSchema: z.ZodType<FilterAST, FilterAST> = /* @__PURE__ */ z.object({
	root: filterGroupSchema,
})

const sortDirectionEnum: z.ZodEnum<{ asc: "asc"; desc: "desc" }> = /* @__PURE__ */ z.enum(["asc", "desc"])

/** The `limit` param: coerced, at least 1, at most maxLimit, defaultLimit when absent */
function limitSchema(defaultLimit: number, maxLimit: number): z.ZodDefault<z.ZodCoercedNumber<unknown>> {
	return z.coerce.number().int().min(1).max(maxLimit).default(defaultLimit).meta({
		description: LIMIT_DESCRIPTION,
		examples: LIMIT_EXAMPLES,
	})
}

const defaultLimitSchema = /* @__PURE__ */ limitSchema(PAGINATION_DEFAULTS.defaultLimit, PAGINATION_DEFAULTS.maxLimit)

/** The `limit` param for this pagination; the shared default instance when it is the default */
function limitSchemaFor(pagination: PaginationConfig | undefined): z.ZodDefault<z.ZodCoercedNumber<unknown>> {
	const defaultLimit = pagination?.defaultLimit ?? PAGINATION_DEFAULTS.defaultLimit
	const maxLimit = pagination?.maxLimit ?? PAGINATION_DEFAULTS.maxLimit
	const isDefault = defaultLimit === PAGINATION_DEFAULTS.defaultLimit && maxLimit === PAGINATION_DEFAULTS.maxLimit
	return isDefault ? defaultLimitSchema : limitSchema(defaultLimit, maxLimit)
}

/** The values of `extendFields`' keys in `data`; `{}` without extensions */
function pickExtended<T extends Record<string, z.ZodType>>(
	extendFields: T | undefined,
	data: Record<string, unknown>,
): { [K in keyof T]: z.infer<T[K]> } {
	const keys = Object.keys(extendFields ?? {})
	return Object.fromEntries(keys.map((key) => [key, data[key]])) as { [K in keyof T]: z.infer<T[K]> }
}

export {
	baseListQueryShape,
	filterAstSchema,
	langQueryField,
	limitSchemaFor,
	parsedFieldsSchema,
	pickExtended,
	selectQueryField,
	sortDirectionEnum,
}
