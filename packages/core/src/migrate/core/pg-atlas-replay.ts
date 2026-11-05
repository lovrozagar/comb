/**
 * The comb-owned statements Atlas's replay of a Postgres history still needs to run, in place: Atlas
 * OSS will not take a view or an extension in what it loads, but what comes after one may depend on
 * it (a LANGUAGE sql body reading a view, a SETOF it, a column of its row type, a view over an
 * extension's function). Each is handed to the dev database in a DO block, which Atlas runs and its
 * OSS inspection does not read.
 */

/** `sql` inside a DO block, under a dollar tag `sql` does not hold */
function inDoBlock(sql: string): string {
	let tag = "comb_view"
	for (let i = 1; sql.includes(`$${tag}$`); i++) tag = `comb_view${i}`
	return `DO $comb$ BEGIN EXECUTE $${tag}$${sql}$${tag}$; END $comb$`
}

/** `code` (codeOf), a view's or materialized view's create or drop, as Atlas replays it; undefined for any other */
const viewReplay = (sql: string, code: string): string | undefined =>
	/^(?:CREATE (?:OR REPLACE )?(?:MATERIALIZED )?VIEW|DROP (?:MATERIALIZED )?VIEW)\b/i.test(code)
		? inDoBlock(sql)
		: undefined

/**
 * `code`, an extension's create or drop, as baseline's replay runs it; a diff gives the dev database its
 * extensions in a prelude instead (pg-objects.ts devPrelude). Undefined for any other statement
 */
const extensionReplay = (sql: string, code: string): string | undefined =>
	/^(?:CREATE|DROP) EXTENSION\b/i.test(code) ? inDoBlock(sql) : undefined

export { extensionReplay, viewReplay }
