/**
 * OpenAPI description + examples constants for list/retrieve query parameters.
 *
 * Used by createListQuerySchema / createRetrieveQuerySchema to attach Zod .meta({ ... })
 * that flows through z.toJSONSchema({ io: "input" }) into OpenAPI parameters[].schema.
 * Extract here so every endpoint inherits consistent copy.
 */

const CURSOR_DESCRIPTION =
	"Opaque cursor for forward pagination. Pass the nextCursor from the previous response. Takes precedence over page when both are sent."
const CURSOR_EXAMPLES = ["eyJpZCI6IjAxSCJ9"]

const LIMIT_DESCRIPTION = "Maximum number of items per page. Defaults to 20, capped by the endpoint's maxLimit."
const LIMIT_EXAMPLES = [20, 50]

const PAGE_DESCRIPTION = "1-based page number for offset pagination. Ignored when cursor is present."
const PAGE_EXAMPLES = [1, 2]

const Q_DESCRIPTION = "Free-text search query applied across the endpoint's configured search fields."
const Q_EXAMPLES = ["invoice", "acme corp"]

const LANG_DESCRIPTION =
	"BCP-47 language tag selecting localized text fields (falls back to default locale when absent)."
const LANG_EXAMPLES = ["en", "de", "fr"]

const SELECT_DESCRIPTION =
	"PostgREST-style sparse fieldset. Scalars comma-separated; relations embedded as name(fields); wildcard * selects all scalars. Docs: https://docs.postgrest.org/en/stable/references/api/resource_embedding.html"
const SELECT_EXAMPLES = ["id,name,email", "id,author(name)", "id,author(name,posts(title))", "*"]

const FILTER_DESCRIPTION =
	"PostgREST-style filter expression. Grammar: field.op.value; logical or(...) and and(...). Ops: eq, neq, gt, gte, lt, lte, in, nin, like, ilike, is, contains. Docs: https://docs.postgrest.org/en/stable/references/api/tables_views.html#horizontal-filtering"
const FILTER_EXAMPLES = ["status.eq.active", "name.ilike.*acme*", "or(status.eq.active,status.eq.pending)"]

const ORDER_DESCRIPTION =
	"PostgREST-style sort expression. Grammar: field[.asc|.desc][.nullsfirst|.nullslast], comma-separated for multi-sort. Docs: https://docs.postgrest.org/en/stable/references/api/tables_views.html#ordering"
const ORDER_EXAMPLES = ["createdAt.desc", "name.asc,createdAt.desc.nullslast"]

export {
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
}
