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
import { invalidPage } from "./trusted.ts"
import type { FieldSelection, FilterAST, FilterGroup, ParsedFields } from "./types.ts"

const selectQueryField: z.ZodOptional<z.ZodString> = /* @__PURE__ */ z.string().max(500).optional().meta({
	description: SELECT_DESCRIPTION,
	examples: SELECT_EXAMPLES,
})

const langQueryField: z.ZodOptional<z.ZodString> = /* @__PURE__ */ z.string().min(2).max(10).optional().meta({
	description: LANG_DESCRIPTION,
	examples: LANG_EXAMPLES,
})

const baseListQueryShape: { cursor: z.ZodOptional<z.ZodString> } = {
	/* any string: readCursor answers every one it cannot use, past MAX_CURSOR_LENGTH included, with
	   invalid_cursor, so a client restarts on one key (C5); the bound is published all the same */
	cursor: /* @__PURE__ */ z.string().optional().meta({
		description: CURSOR_DESCRIPTION,
		examples: CURSOR_EXAMPLES,
		maxLength: MAX_CURSOR_LENGTH,
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

/** A count param as a schema takes it: a number, or the string of one in decimal digits */
type CountParam = z.ZodPreprocess<z.ZodNumber, unknown>

/* a count in a query string: decimal digits, with no sign, space, fraction, exponent or 0x, 0b or 0o prefix (U36) */
const DECIMAL_DIGITS = /^\d+$/

/** `raw` as a number: as given, or read from decimal digits; NaN for any other string, which a number schema refuses */
const fromDigits = (raw: unknown): unknown =>
	typeof raw === "string" ? (DECIMAL_DIGITS.test(raw) ? Number(raw) : Number.NaN) : raw

/** `raw` as a page, a whole number from 1; anything else is invalid_page, as the builders answer it (U36) */
function pageFrom(raw: unknown): unknown {
	const page = fromDigits(raw)
	if (typeof page !== "number" || !Number.isInteger(page) || page < 1) throw invalidPage(raw)
	return page
}

/**
 * The `limit` param: decimal digits or a number, at least 1, at most maxLimit, defaultLimit when
 * absent. JSON Schema publishes a preprocessed param by its inner number, so the metadata sits
 * there, and names the default the outer `.default()` applies
 */
function limitSchema(defaultLimit: number, maxLimit: number): z.ZodDefault<CountParam> {
	const limit = z.number().int().min(1).max(maxLimit).meta({
		default: defaultLimit,
		description: LIMIT_DESCRIPTION,
		examples: LIMIT_EXAMPLES,
	})
	return z.preprocess(fromDigits, limit).default(defaultLimit)
}

const defaultLimitSchema = /* @__PURE__ */ limitSchema(PAGINATION_DEFAULTS.defaultLimit, PAGINATION_DEFAULTS.maxLimit)

/** The `limit` param for this pagination; the shared default instance when it is the default */
function limitSchemaFor(pagination: PaginationConfig | undefined): z.ZodDefault<CountParam> {
	const defaultLimit = pagination?.defaultLimit ?? PAGINATION_DEFAULTS.defaultLimit
	const maxLimit = pagination?.maxLimit ?? PAGINATION_DEFAULTS.maxLimit
	const isDefault = defaultLimit === PAGINATION_DEFAULTS.defaultLimit && maxLimit === PAGINATION_DEFAULTS.maxLimit
	return isDefault ? defaultLimitSchema : limitSchema(defaultLimit, maxLimit)
}

/**
 * The `page` param: decimal digits or a number, a whole number from 1. Neither bound is a field
 * error, which would give one condition two contracts: a page that is no whole number from 1 is
 * `invalid_page` (U36), and maxPage, published but not checked here, is the list schema's
 * `page_too_deep` (L2), each as an unbounded list answers it
 */
function pageSchema(maxPage: number): z.ZodOptional<CountParam> {
	const page = z
		.number()
		.int()
		.min(1)
		.meta({ description: PAGE_DESCRIPTION, examples: PAGE_EXAMPLES, maximum: maxPage })
	return z.preprocess(pageFrom, page).optional()
}

const defaultPageSchema = /* @__PURE__ */ pageSchema(PAGINATION_DEFAULTS.maxPage)

/**
 * The `page` param for this pagination; the shared default instance when it is the default. A
 * maxPage whose last offset passes 2^53 - 1 is refused: SQLite fails on an OFFSET past int64.
 */
function pageSchemaFor(pagination: PaginationConfig | undefined): z.ZodOptional<CountParam> {
	const maxPage = pagination?.maxPage ?? PAGINATION_DEFAULTS.maxPage
	const maxLimit = pagination?.maxLimit ?? PAGINATION_DEFAULTS.maxLimit
	if (!Number.isSafeInteger(maxPage) || maxPage < 1 || (maxPage - 1) * maxLimit > Number.MAX_SAFE_INTEGER) {
		throw new TypeError(
			`createListQuerySchema: pagination.maxPage must be a positive integer whose last offset, (maxPage - 1) * maxLimit, is at most 2^53 - 1; got ${maxPage}`,
		)
	}
	return maxPage === PAGINATION_DEFAULTS.maxPage ? defaultPageSchema : pageSchema(maxPage)
}

/** Throw when `extendFields` names a key of `reserved`, which the schema owns */
function assertNotReserved(
	builder: string,
	extendFields: Record<string, unknown> | undefined,
	reserved: readonly string[],
): void {
	const taken = Object.keys(extendFields ?? {}).find((key) => reserved.includes(key))
	if (taken !== undefined) throw new TypeError(`${builder}: extend.${taken} is reserved; name the extension otherwise`)
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
	assertNotReserved,
	baseListQueryShape,
	filterAstSchema,
	langQueryField,
	limitSchemaFor,
	pageSchemaFor,
	parsedFieldsSchema,
	pickExtended,
	selectQueryField,
	sortDirectionEnum,
}
