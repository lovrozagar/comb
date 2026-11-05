/** The zod pieces the list and retrieve query schemas share: request params and parsed outputs. */
import * as z from "zod"
import { MAX_CURSOR_LENGTH } from "./cursor.ts"

import {
	CURSOR_DESCRIPTION,
	LANG_DESCRIPTION,
	LANG_EXAMPLES,
	limitParamMeta,
	PAGE_DESCRIPTION,
	PAGE_EXAMPLES,
	selectParamMeta,
} from "./descriptions.ts"
import { FILTER_OPERATORS } from "./filter-parse.ts"
import { PAGINATION_DEFAULTS } from "./schema-limits.ts"
import type { FieldsConfig, PaginationConfig } from "./schema-types.ts"
import { invalidPage } from "./trusted.ts"
import type { FieldSelection, FilterAST, FilterGroup, ParsedFields } from "./types.ts"

/** The `select` param for an endpoint of these fields, its text and examples theirs */
const selectQueryFieldFor = (fields: FieldsConfig): z.ZodOptional<z.ZodString> =>
	z.string().max(500).optional().meta(selectParamMeta(fields))

const langQueryField: z.ZodOptional<z.ZodString> = /* @__PURE__ */ z.string().min(2).max(10).optional().meta({
	description: LANG_DESCRIPTION,
	examples: LANG_EXAMPLES,
})

/** The params every list endpoint takes, whatever its config */
const baseListQueryShape: {
	/** the `nextCursor` of the previous page, opened only by the list's builder; it wins over `page` */
	cursor: z.ZodOptional<z.ZodString>
} = {
	/* any string: readCursor answers every one it cannot use, past MAX_CURSOR_LENGTH included, with
	   invalid_cursor, so a client restarts on one key (C5); the bound is published all the same */
	cursor: /* @__PURE__ */ z.string().optional().meta({
		description: CURSOR_DESCRIPTION,
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

/**
 * `raw` as a number: as given, or read from decimal digits, at most `max`'s unless the first is no
 * zero; NaN for any other string, which a number schema refuses. Digits past `max`'s that start with
 * no zero hold a number past it, which its bound refuses; leading zeros past them hold none, so the
 * query string comb accepts stays within maxQueryBytes (AB4-9 of area B)
 */
function fromDigits(raw: unknown, max: number): unknown {
	if (typeof raw !== "string") return raw
	const padded = raw.length > String(max).length && raw.startsWith("0")
	return DECIMAL_DIGITS.test(raw) && !padded ? Number(raw) : Number.NaN
}

/** `raw` as a page, a whole number from 1; anything else is invalid_page, as the builders answer it (U36) */
function pageFrom(raw: unknown, maxPage: number): unknown {
	const page = fromDigits(raw, maxPage)
	if (typeof page !== "number" || !Number.isInteger(page) || page < 1) throw invalidPage(raw)
	return page
}

/**
 * The `limit` param: decimal digits or a number, at least 1, at most maxLimit, defaultLimit when
 * absent. JSON Schema publishes a preprocessed param by its inner number, so the metadata sits
 * there, and names the default the outer `.default()` applies
 */
function limitSchema(defaultLimit: number, maxLimit: number): z.ZodDefault<CountParam> {
	const limit = z
		.number()
		.int()
		.min(1)
		.max(maxLimit)
		.meta({ default: defaultLimit, ...limitParamMeta(defaultLimit, maxLimit) })
	return z.preprocess((raw) => fromDigits(raw, maxLimit), limit).default(defaultLimit)
}

const defaultLimitSchema = /* @__PURE__ */ limitSchema(PAGINATION_DEFAULTS.defaultLimit, PAGINATION_DEFAULTS.maxLimit)

/** A pagination config createListQuerySchema refuses, naming its key */
const paginationError = (message: string) => new TypeError(`createListQuerySchema: pagination.${message}`)

/**
 * Throw a TypeError naming the key unless maxLimit is a whole number from 1 and defaultLimit one
 * from 1 to maxLimit (QL6 of r22b): zod's `.default()` skips the inner check, so a default past the
 * maximum would answer every request without a `limit` with a 400. A maxLimit given alone below
 * the default limit is told to set defaultLimit too, rather than clamped silently
 */
function assertLimits(pagination: PaginationConfig | undefined, defaultLimit: number, maxLimit: number): void {
	if (!Number.isSafeInteger(maxLimit) || maxLimit < 1)
		throw paginationError(`maxLimit must be a whole number from 1; got ${maxLimit}`)
	if (pagination?.defaultLimit === undefined && defaultLimit > maxLimit)
		throw paginationError(
			`maxLimit ${maxLimit} is below the default limit ${defaultLimit}: set pagination.defaultLimit too`,
		)
	if (!Number.isSafeInteger(defaultLimit) || defaultLimit < 1 || defaultLimit > maxLimit)
		throw paginationError(`defaultLimit must be a whole number from 1 to maxLimit (${maxLimit}); got ${defaultLimit}`)
}

/**
 * The `limit` param for this pagination; the shared default instance when it is the default. Built
 * before the page param, so its bounds are checked before maxPage's offset multiplies by maxLimit
 */
function limitSchemaFor(pagination: PaginationConfig | undefined): z.ZodDefault<CountParam> {
	const defaultLimit = pagination?.defaultLimit ?? PAGINATION_DEFAULTS.defaultLimit
	const maxLimit = pagination?.maxLimit ?? PAGINATION_DEFAULTS.maxLimit
	assertLimits(pagination, defaultLimit, maxLimit)
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
	return z.preprocess((raw) => pageFrom(raw, maxPage), page).optional()
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

// lookup-table: the names an extension may not take, the type's source too
/** The params and output keys a list query schema owns, which `extend` may not name: one would replace a checked value */
const RESERVED_LIST_KEYS = [
	"cursor",
	"filter",
	"filterAst",
	"lang",
	"limit",
	"limitBound",
	"order",
	"page",
	"pageBound",
	"parsedFields",
	"parsedSort",
	"q",
	"select",
	"sortOrderBy",
	"tiebreak",
	"validated",
] as const

// lookup-table: the names an extension may not take, the type's source too
/** The params and output keys a retrieve query schema owns, which `extend` may not name */
const RESERVED_RETRIEVE_KEYS = ["lang", "parsedFields", "select"] as const

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
	RESERVED_LIST_KEYS,
	RESERVED_RETRIEVE_KEYS,
	selectQueryFieldFor,
	sortDirectionEnum,
}
