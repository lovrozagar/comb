/**
 * The Postgres functions a migration may call without a rating of its own (pg-tree.ts): built-ins
 * that read their arguments and return a value, writing nothing and running no SQL, plus the
 * extensions' few that do the same (uuid-ossp, unaccent, pgcrypto's digest). A call of any other
 * function runs code comb cannot read, and is unsafe; `setval` is cautious, as a RESTART is, and
 * so is `nextval`, whose advance a rollback does not undo. `current_setting` is no pure call: it
 * copies a setting, an application's secret among them, into what it writes.
 * Names are as the parser gives them, a `pg_catalog.` qualifier dropped.
 */

// lookup-table: the side-effect-free built-ins a migration's expressions call
const PURE: ReadonlySet<string> = /* @__PURE__ */ new Set([
	/* text */
	"ascii",
	"btrim",
	"char_length",
	"character_length",
	"chr",
	"concat",
	"concat_ws",
	"decode",
	"encode",
	"format",
	"initcap",
	"left",
	"length",
	"lower",
	"lpad",
	"ltrim",
	"md5",
	"overlay",
	"position",
	"regexp_count",
	"regexp_instr",
	"regexp_like",
	"regexp_substr",
	"octet_length",
	"quote_ident",
	"quote_literal",
	"quote_nullable",
	"regexp_match",
	"regexp_matches",
	"regexp_replace",
	"regexp_split_to_array",
	"repeat",
	"replace",
	"reverse",
	"right",
	"rpad",
	"rtrim",
	"split_part",
	"starts_with",
	"string_agg",
	"string_to_array",
	"strpos",
	"string_to_table",
	"substr",
	"substring",
	"to_hex",
	"sha224",
	"sha256",
	"sha384",
	"sha512",
	"translate",
	"unaccent",
	"upper",
	/* numbers */
	"abs",
	"ceil",
	"ceiling",
	"floor",
	"cbrt",
	"degrees",
	"div",
	"exp",
	"ln",
	"log",
	"log10",
	"pi",
	"radians",
	"mod",
	"power",
	"random",
	"round",
	"sign",
	"sqrt",
	"trunc",
	/* dates and times */
	"age",
	"clock_timestamp",
	"date_part",
	"date_bin",
	"isfinite",
	"date_trunc",
	"extract",
	"justify_days",
	"justify_hours",
	"justify_interval",
	"make_date",
	"make_interval",
	"make_time",
	"make_timestamp",
	"make_timestamptz",
	"now",
	"statement_timestamp",
	"timezone",
	"to_char",
	"to_date",
	"to_number",
	"to_timestamp",
	"transaction_timestamp",
	/* identifiers and hashes */
	"digest",
	"gen_random_uuid",
	"uuid_generate_v1",
	"uuid_generate_v4",
	/* JSON */
	"array_to_json",
	"json_agg",
	"json_array_length",
	"json_build_array",
	"json_build_object",
	"json_typeof",
	"json_object_agg",
	"jsonb_agg",
	"jsonb_array_elements",
	"jsonb_array_elements_text",
	"jsonb_array_length",
	"jsonb_build_array",
	"jsonb_build_object",
	"jsonb_each",
	"jsonb_each_text",
	"jsonb_extract_path",
	"jsonb_extract_path_text",
	"jsonb_insert",
	"jsonb_object_agg",
	"jsonb_object_keys",
	"jsonb_path_exists",
	"jsonb_path_match",
	"jsonb_path_query",
	"jsonb_path_query_array",
	"jsonb_path_query_first",
	"jsonb_pretty",
	"jsonb_set",
	"jsonb_strip_nulls",
	"jsonb_typeof",
	"row_to_json",
	"to_json",
	"to_jsonb",
	/* arrays and sets */
	"array_agg",
	"array_append",
	"array_cat",
	"array_length",
	"array_dims",
	"array_fill",
	"array_lower",
	"array_ndims",
	"array_positions",
	"array_replace",
	"array_upper",
	"trim_array",
	"array_position",
	"array_prepend",
	"array_remove",
	"array_to_string",
	"cardinality",
	"generate_series",
	"unnest",
	/* aggregates */
	"avg",
	"bool_and",
	"bool_or",
	"count",
	"every",
	"max",
	"min",
	"sum",
	/* full text search */
	"plainto_tsquery",
	"setweight",
	"to_tsquery",
	"to_tsvector",
	"ts_rank",
	"websearch_to_tsquery",
	/* sequences, read */
	"currval",
	"lastval",
	/* window functions */
	"cume_dist",
	"dense_rank",
	"first_value",
	"lag",
	"last_value",
	"lead",
	"nth_value",
	"ntile",
	"percent_rank",
	"rank",
	"row_number",
	/* catalog lookups, read */
	"to_regclass",
	"to_regtype",
])

/**
 * What a call of `name` (its parts as the parser gives them) makes the statement, if anything.
 * A name a migration defined (`defined`, keyed as nameKey keys it) is that migration's function,
 * not the built-in, unless the call names pg_catalog: an overload of `lower` for a type of its
 * own is what Postgres resolves `lower(x)` to. A bare call names it in any schema, as the search
 * path may hold that schema; one qualified by `schema`, the target's, names it there. Only
 * pg_catalog names a built-in: `public.lower` is a function of public's, from outside the history
 * unless a migration defined it (M90).
 */
function builtinFinding(
	name: readonly string[],
	{ defined, schema }: { defined: ReadonlySet<string>; schema: string },
): { level: "cautious" | "unsafe"; note: string } | undefined {
	const catalog = name[0] === "pg_catalog"
	const parts = catalog ? name.slice(1) : name
	const key = parts.join(".")
	/* a bare name resolves through the search path, so it may be a migration's function in any schema; defined keys the target's schema out */
	const mine =
		parts.length === 1
			? [...defined].some((each) => each.split(".").at(-1) === key)
			: defined.has(key) || (parts.length === 2 && parts[0] === schema && defined.has(parts[1] as string))
	if (!catalog && mine) return { level: "unsafe", note: `calls ${key}, a function a migration defined` }
	if (parts.length === 1 && PURE.has(key)) return undefined
	if (key === "setval") return { level: "cautious", note: "sets a sequence, as a RESTART does" }
	if (key === "nextval") return { level: "cautious", note: "advances a sequence; a rollback does not undo it" }
	if (key === "dblink" || key === "dblink_exec")
		return { level: "unsafe", note: `calls ${key}, which runs SQL comb cannot read` }
	return { level: "unsafe", note: `calls ${key}, which comb cannot read` }
}

export { builtinFinding, PURE as PURE_BUILTINS }
