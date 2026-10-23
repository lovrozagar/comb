/**
 * The Postgres functions a migration may call without a rating of its own (pg-tree.ts): built-ins
 * that read their arguments and return a value, writing nothing and running no SQL, plus the
 * extensions' few that do the same (uuid-ossp, unaccent, pgcrypto's digest). A call of any other
 * function runs code comb cannot read, and is unsafe; `setval` is cautious, as a RESTART is.
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
	"substr",
	"substring",
	"to_hex",
	"translate",
	"trim",
	"unaccent",
	"upper",
	/* numbers */
	"abs",
	"ceil",
	"ceiling",
	"floor",
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
	/* sequences, read or advanced */
	"currval",
	"lastval",
	"nextval",
	/* settings, read */
	"current_setting",
])

/**
 * What a call of `name` (its parts as the parser gives them) makes the statement, if anything.
 * A name a migration defined (`defined`, keyed as nameKey keys it) is that migration's function,
 * not the built-in, unless the call names pg_catalog: an overload of `lower` for a type of its
 * own is what Postgres resolves `lower(x)` to.
 */
function builtinFinding(
	name: readonly string[],
	defined: ReadonlySet<string>,
): { level: "cautious" | "unsafe"; note: string } | undefined {
	const catalog = name[0] === "pg_catalog"
	const parts = catalog || name[0] === "public" ? name.slice(1) : name
	const key = parts.join(".")
	if (!catalog && defined.has(key)) return { level: "unsafe", note: `calls ${key}, a function a migration defined` }
	if (parts.length === 1 && PURE.has(key)) return undefined
	if (key === "setval") return { level: "cautious", note: "sets a sequence, as a RESTART does" }
	if (key === "dblink" || key === "dblink_exec")
		return { level: "unsafe", note: `calls ${key}, which runs SQL comb cannot read` }
	return { level: "unsafe", note: `calls ${key}, which comb cannot read` }
}

export { builtinFinding }
