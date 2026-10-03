/**
 * OpenAPI descriptions + examples for list/retrieve query parameters.
 *
 * Attached through Zod `.meta({ ... })` so they flow through
 * z.toJSONSchema({ io: "input" }) into OpenAPI parameters[].schema. Parameters
 * whose rules differ per endpoint (filter, order, q) are generated from the
 * same config that validates the request, so the text cannot drift from what
 * the parser accepts — and stays when a publisher strips `x-*` extensions.
 */
import type { FilterLimits } from "./filter.ts"
import type { FieldType, FilterOperator } from "./types.ts"

const CURSOR_DESCRIPTION =
	"Opaque cursor for forward pagination. Pass the nextCursor from the previous response with the same order. Takes precedence over page when both are sent."
const CURSOR_EXAMPLES = ["eyJpIjoiMDFIIiwicyI6IiIsInYiOltdfQ"]

const LIMIT_DESCRIPTION = "Maximum number of items per page. Defaults to 20, capped by the endpoint's maxLimit."
const LIMIT_EXAMPLES = [20, 50]

const PAGE_DESCRIPTION = "1-based page number for offset pagination. Ignored when cursor is present."
const PAGE_EXAMPLES = [1, 2]

const LANG_DESCRIPTION =
	"BCP-47 language tag selecting localized text fields (falls back to default locale when absent)."
const LANG_EXAMPLES = ["en", "de", "fr"]

const SELECT_DESCRIPTION =
	"PostgREST-style sparse fieldset. Scalars comma-separated; relations embedded as name(fields); wildcard * selects all scalars. Docs: https://docs.postgrest.org/en/stable/references/api/resource_embedding.html"
const SELECT_EXAMPLES = ["id,name,email", "id,author(name)", "id,author(name,posts(title))", "*"]

type ParamMeta = { description: string; examples: string[] }

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
		"`in`/`nin` take `(a,b)`; `is` takes `null` or `notnull`.",
		`At most ${limits.maxConditions} conditions, ${limits.maxDepth} nested groups, ${limits.maxInValues} in/nin values.`,
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

function orderParamMeta(sort: readonly string[], maxSortKeys: number): ParamMeta & { pattern: string } {
	const [first = "", second] = sort
	const entry = `(?:${sort.map(escapeRegExp).join("|")})(?:\\.(?:asc|desc))?(?:\\.(?:nullsfirst|nullslast))?`
	return {
		description: [
			`Sort keys, comma-separated, each \`field[.asc|.desc][.nullsfirst|.nullslast]\`; at most ${maxSortKeys}.`,
			`Sortable: ${sort.join(", ")}. Default: ${first}.desc.`,
			"Nulls sort last ascending and first descending unless stated.",
		].join(" "),
		examples: second ? [`${first}.desc`, `${second}.asc,${first}.desc`] : [`${first}.desc`, `${first}.asc`],
		pattern: `^${entry}(?:,${entry}){0,${Math.max(0, maxSortKeys - 1)}}$`,
	}
}

function searchParamMeta(search: readonly string[]): ParamMeta {
	return {
		description: `Free-text search over: ${search.join(", ")}. Whitespace-separated terms must all match.`,
		examples: ["acme", "acme corp"],
	}
}

export {
	CURSOR_DESCRIPTION,
	CURSOR_EXAMPLES,
	filterParamMeta,
	LANG_DESCRIPTION,
	LANG_EXAMPLES,
	LIMIT_DESCRIPTION,
	LIMIT_EXAMPLES,
	orderParamMeta,
	PAGE_DESCRIPTION,
	PAGE_EXAMPLES,
	searchParamMeta,
	SELECT_DESCRIPTION,
	SELECT_EXAMPLES,
}
