/**
 * What each kind of SQLite target runs, which check holds a file to before anything applies (S1 of r19,
 * S1 of r22): a local SQLite file runs what SQLite does, and a libsql server (sqld) what its parser and
 * authorizer let through. A D1 database runs what its own engine does, which check asks it (d1-engine.ts,
 * SD1 of r22), so no list here. No `-- comb:allow-unsafe:` clears a refusal here: the target would fail
 * the file at apply.
 */
import type { Pragma } from "./sql-code.ts"

// S1 of r22
/**
 * Where a SQLite-family file applies, which the CLI reads from its provider: `local` a SQLite file
 * comb opens itself (bun:sqlite, a libsql `file:` or `:memory:`), `sqld` a libsql server (a libsql URL of any other
 * scheme, and Turso, which runs one), `d1` a D1 database through wrangler. Each kind has its own rule of
 * what it runs, so a statement one refuses is refused before anything applies
 */
type TargetKind = "d1" | "local" | "sqld"

/*
 * What the pinned libsql server (sqld 0.24.32) parses, measured on the binary (tests/structure/sqld-pragmas.test.ts
 * runs it and fails when the two differ): a pragma by its bare name, any case, read with no value or set with one;
 * a quoted name, and any name it does not list, is refused at parse
 */
// lookup-table: the pragmas sqld runs as a read
const SQLD_READS: ReadonlySet<string> = /* @__PURE__ */ new Set([
	"analysis_limit",
	"application_id",
	"auto_vacuum",
	"automatic_index",
	"busy_timeout",
	"cache_size",
	"cache_spill",
	"cell_size_check",
	"checkpoint_fullfsync",
	"collation_list",
	"compile_options",
	"data_version",
	"database_list",
	"defer_foreign_keys",
	"encoding",
	"foreign_key_check",
	"foreign_key_list",
	"foreign_keys",
	"freelist_count",
	"fullfsync",
	"function_list",
	"hard_heap_limit",
	"index_info",
	"index_list",
	"index_xinfo",
	"integrity_check",
	"journal_mode",
	"journal_size_limit",
	"legacy_alter_table",
	"locking_mode",
	"max_page_count",
	"mmap_size",
	"module_list",
	"page_count",
	"page_size",
	"pragma_list",
	"query_only",
	"quick_check",
	"read_uncommitted",
	"recursive_triggers",
	"reverse_unordered_selects",
	"schema_version",
	"secure_delete",
	"soft_heap_limit",
	"synchronous",
	"table_info",
	"table_list",
	"table_xinfo",
	"temp_store",
	"threads",
	"trusted_schema",
	"user_version",
	"wal_autocheckpoint",
])

// lookup-table: the pragmas sqld runs with a value or an argument
const SQLD_SETS: ReadonlySet<string> = /* @__PURE__ */ new Set([
	"collation_list",
	"compile_options",
	"data_version",
	"database_list",
	"defer_foreign_keys",
	"encoding",
	"foreign_key_check",
	"foreign_key_list",
	"foreign_keys",
	"freelist_count",
	"function_list",
	"index_info",
	"index_list",
	"index_xinfo",
	"integrity_check",
	"module_list",
	"page_count",
	"pragma_list",
	"quick_check",
	"table_info",
	"table_list",
	"table_xinfo",
	"user_version",
])

/** Whether sqld parses `pragma`: its bare name on the list of its form */
const sqldRuns = (pragma: Pragma): boolean =>
	!pragma.quoted && (pragma.value === undefined ? SQLD_READS : SQLD_SETS).has(pragma.name)

/*
 * The statements sqld refuses whatever their pragma, measured as above: ANALYZE and ATTACH at parse, a TEMP object
 * by keyword, or a table in `temp` by an unquoted schema, at parse, and load_extension() by its authorizer
 */
const SQLD_STATEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
	[/^ANALYZE\b/i, "ANALYZE"],
	[/^ATTACH\b/i, "ATTACH"],
	[/^CREATE TEMP(?:ORARY)? /i, "a TEMP object"],
	[/^CREATE (?:VIRTUAL )?TABLE (?:IF NOT EXISTS )?temp ?\./i, "a table in temp"],
	[/\bload_extension ?\(/i, "load_extension()"],
]

/** Why the libsql server refuses a statement, naming it as a person finds it */
const sqldRefuses = (what: string) =>
	`the libsql server (sqld) behind this database, Turso's included, refuses ${what} before it runs anything, so apply would fail on it; leave it out of the migrations`

/** Why a sqld target refuses `code`, or undefined when sqld runs it */
function sqldRefusal(code: string, pragma: Pragma | undefined): string | undefined {
	if (pragma !== undefined && !sqldRuns(pragma)) {
		const { name, quoted, value } = pragma
		return sqldRefuses(
			quoted ? "a pragma whose name is quoted" : value === undefined ? `a read of ${name}` : `${name} with a value`,
		)
	}
	if (pragma !== undefined) return undefined
	const [, what] = SQLD_STATEMENTS.find(([pattern]) => pattern.test(code)) ?? []
	return what === undefined ? undefined : sqldRefuses(what)
}

/** Why a target of `kind` refuses the statement `code` (the pragma it runs, if one), or undefined when it runs it */
function targetRefusal(code: string, pragma: Pragma | undefined, kind: TargetKind): string | undefined {
	return kind === "sqld" ? sqldRefusal(code, pragma) : undefined
}

export { type TargetKind, targetRefusal }
