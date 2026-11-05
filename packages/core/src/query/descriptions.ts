/**
 * OpenAPI descriptions + examples for list/retrieve query parameters.
 *
 * Attached through Zod `.meta({ ... })` so they flow through
 * z.toJSONSchema({ io: "input" }) into OpenAPI parameters[].schema. Parameters
 * whose rules differ per endpoint (filter, order, q, limit, select) are generated from the
 * same config that validates the request, so the text cannot drift from what
 * the parser accepts — and stays when a publisher strips `x-*` extensions.
 */
import type { FilterLimits } from "./filter.ts"
import { REQUEST_BYTES } from "./schema-limits.ts"
import type { FieldsConfig } from "./schema-types.ts"
import type { FieldType, FilterOperator } from "./types.ts"

/** The OpenAPI description of the `cursor` param */
const CURSOR_DESCRIPTION =
	"Opaque cursor for forward pagination. Pass the nextCursor from the previous response with the same order. Takes precedence over page when both are sent."

/** The OpenAPI description of the `page` param */
const PAGE_DESCRIPTION =
	"1-based page number for offset pagination, up to the endpoint's maxPage (x-comb); page further by cursor. A page that is no whole number from 1, in decimal digits, or zero-padded past maxPage's digits, is a 400 invalid_page, and one past maxPage a 400 page_too_deep, with or without a cursor. Ignored when cursor is present."
/** The OpenAPI examples of the `page` param */
const PAGE_EXAMPLES: number[] = [1, 2]

/** The OpenAPI description of the `lang` param */
const LANG_DESCRIPTION =
	"BCP-47 language tag selecting localized text fields (falls back to default locale when absent)."
/** The OpenAPI examples of the `lang` param */
const LANG_EXAMPLES: string[] = ["en", "de", "fr"]

/** The opening sentences of the `select` param's OpenAPI description; `selectParamMeta` adds the endpoint's fields */
const SELECT_DESCRIPTION =
	"PostgREST-style sparse fieldset. Scalars comma-separated; relations embedded as name(fields); wildcard * selects all scalars. Docs: https://docs.postgrest.org/en/stable/references/api/resource_embedding.html"

/** A query param's OpenAPI text, for `.meta()` on its zod schema */
export type ParamMeta = {
	/** the param's description */
	description: string
	/** values the param accepts */
	examples: string[]
}

/*
 * A cursor publishes no example: it is sealed under the app's secret and the list's scope, so no
 * value opens on every endpoint, and one sealed under any other is an invalid_cursor.
 */

/** The `limit` param's OpenAPI text, stating the endpoint's default and cap, which are its examples */
function limitParamMeta(
	defaultLimit: number,
	maxLimit: number,
): {
	/** the param's description */
	description: string
	/** the default and the cap, once each */
	examples: number[]
} {
	return {
		description: `Maximum number of items per page, in decimal digits, zero-padded to at most ${String(maxLimit).length} of them. Defaults to ${defaultLimit}, at most ${maxLimit}.`,
		examples: [...new Set([defaultLimit, maxLimit])],
	}
}

/**
 * The `select` param's OpenAPI text, listing the fields and relations `fields` declares. Its examples
 * are the first scalars, one relation with one of its fields when one has any, and `*`
 */
function selectParamMeta(fields: FieldsConfig): ParamMeta {
	const relationFields = fields.relationFields ?? {}
	/* a relation selects only the fields it declares, none when it declares none */
	const selectable = (name: string): readonly string[] =>
		(Object.hasOwn(relationFields, name) ? relationFields[name] : undefined) ?? []
	const relations = (fields.relations ?? []).map((name) => `${name} (${selectable(name).join(", ") || "none"})`)
	const embedded = (fields.relations ?? []).find((name) => selectable(name).length > 0)
	const examples = new Set<string>()
	if (fields.scalars.length > 0) examples.add(fields.scalars.slice(0, 3).join(","))
	if (embedded !== undefined)
		examples.add([...fields.scalars.slice(0, 1), `${embedded}(${selectable(embedded)[0]})`].join(","))
	examples.add("*")
	return {
		description: [
			SELECT_DESCRIPTION,
			`Fields: ${fields.scalars.join(", ") || "none"}.`,
			relations.length > 0
				? `Relations, each with the fields it selects: ${relations.join("; ")}; none nests another.`
				: "No relations.",
		].join(" "),
		examples: [...examples],
	}
}

/* One value per type that every operator in the example accepts. */
function sampleCondition(field: string, type: FieldType): string {
	switch (type) {
		case "string":
			return `${field}.ilike.*acme*`
		case "number":
			return `${field}.gte.10`
		case "date":
			return `${field}.gte.1735689600000`
		case "boolean":
			return `${field}.eq.true`
		case "enum":
			return `${field}.is.notnull`
	}
}

/**
 * The `filter` param's OpenAPI text: its grammar, each field with the operators its type takes, and
 * `limits`. Its examples are built from the first fields, so each parses on this endpoint
 */
function filterParamMeta(
	fields: Record<string, FieldType>,
	operatorsFor: (type: FieldType) => readonly FilterOperator[],
	limits: FilterLimits,
): ParamMeta {
	const entries = Object.entries(fields)
	const fieldList = entries.map(([field, type]) => `${field} (${type}: ${operatorsFor(type).join(", ")})`).join("; ")
	const description = [
		"Filter expression `field.op.value`; `,` joins conditions with AND; group with `or(...)` and `and(...)`.",
		`Fields: ${fieldList}.`,
		"`like` is case-sensitive and `ilike` ignores ASCII case; `*` is the wildcard.",
		"`in`/`nin` take `(a,b)`; `is` takes `null` or `notnull`, and `true` or `false` on a boolean.",
		`At most ${limits.maxConditions} conditions, ${limits.maxDepth} nested groups, ${limits.maxInValues} in/nin values per list, ${limits.maxValues} values in all, ${limits.maxPatternBytes} bytes in a like or ilike pattern once escaped, and at most ${REQUEST_BYTES.filter} bytes however a URL or a form encodes it.`,
	].join(" ")

	const samples = entries.map(([field, type]) => sampleCondition(field, type))
	const text = entries.find(([, type]) => type === "string")
	const examples = new Set<string>(samples.slice(0, 1))
	if (text) examples.add(sampleCondition(text[0], "string"))
	if (samples.length > 1) examples.add(`or(${samples[0]},${samples[1]})`)

	return { description, examples: [...examples] }
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** The `order` param's OpenAPI text over the sortable fields in `sort`, the first of which is the default, descending */
function orderParamMeta(
	sort: readonly string[],
	maxSortKeys: number,
): ParamMeta & {
	/** a regular expression matching every `order` this endpoint takes, up to `maxSortKeys` keys */
	pattern: string
} {
	const [first = "", second] = sort
	const entry = `(?:${sort.map(escapeRegExp).join("|")})(?:\\.(?:asc|desc))?(?:\\.(?:nullsfirst|nullslast))?`
	return {
		description: [
			`Sort keys, comma-separated, each \`field[.asc|.desc][.nullsfirst|.nullslast]\`; at most ${maxSortKeys}.`,
			`Sortable: ${sort.join(", ")}. Default: ${first}.desc.`,
			"Nulls sort last ascending and first descending unless stated.",
		].join(" "),
		/* a second key only where the endpoint takes two */
		examples: second
			? [`${first}.desc`, maxSortKeys > 1 ? `${second}.asc,${first}.desc` : `${second}.asc`]
			: [`${first}.desc`, `${first}.asc`],
		pattern: `^${entry}(?:,${entry}){0,${Math.max(0, maxSortKeys - 1)}}$`,
	}
}

/** The `q` param's OpenAPI text over the fields in `search`, with at most `maxTerms` words */
function searchParamMeta(search: readonly string[], maxTerms: number): ParamMeta {
	return {
		description: `Free-text search over: ${search.join(", ")}. Whitespace-separated terms must all match; at most ${maxTerms} terms, and at most ${REQUEST_BYTES.q} bytes however a URL or a form encodes it.`,
		examples: ["acme", "acme corp"],
	}
}

export {
	CURSOR_DESCRIPTION,
	filterParamMeta,
	LANG_DESCRIPTION,
	LANG_EXAMPLES,
	limitParamMeta,
	orderParamMeta,
	PAGE_DESCRIPTION,
	PAGE_EXAMPLES,
	searchParamMeta,
	SELECT_DESCRIPTION,
	selectParamMeta,
}
