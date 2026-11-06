/**
 * Atlas's failures in comb's terms, where comb knows the fix: Docker missing for the default dev
 * database, another apply's lock, a database with objects and no history (the target's, or the dev
 * database's, which Atlas finds as it snapshots it), a schema that is missing, an enum value Atlas
 * cannot drop, and what Atlas OSS refuses. Atlas's own text is scrubbed of secrets; comb's words
 * are never.
 */

/**
 * A statement Atlas names as the one that failed, without its own `;`, which reads as part of the
 * sentence comb puts it in
 */
const failedStatement = (stmt: string): string => stmt.replace(/;\s*$/, "")

/** comb's answer to a database Atlas calls not clean: objects but no history */
const NOT_CLEAN =
	"the database has objects but no migration history, and no shared history row matches this directory's files (a database made by hand, or another directory's history); if its schema matches the migrations, record them with comb migrate baseline"

/**
 * comb's answer to a database Atlas calls not clean, undefined for any other failure. Atlas snapshots
 * the dev database before it replays on it: not clean there is the dev database's, as is any on a
 * call that reached no other database; else the target's
 */
function notClean(stderr: string, scrub: (text: string) => string, devOnly: boolean): string | undefined {
	const dev = devOnly
		? /connected database is not clean: (?:found )?([^\n]*)/
		: /taking database snapshot: .*?connected database is not clean: (?:found )?([^\n]*)/
	const [, held] = dev.exec(stderr) ?? []
	if (held !== undefined)
		return `devUrl must be an empty database, and it holds ${scrub(held.trim())}; point devUrl at an empty database, or empty this one`
	return /connected database is not clean/.test(stderr) ? NOT_CLEAN : undefined
}

// lookup-table: what Atlas says where comb's answer names no part of it, and that answer
const FIXED: ReadonlyArray<readonly [RegExp, string]> = [
	[
		/Error: docker:|Cannot connect to the Docker daemon/i,
		"Atlas needs Docker for the default devUrl (docker://postgres/17/dev); set devUrl to an empty Postgres database instead",
	],
	[
		/lock is held by other session/,
		"another migrate apply is running on this database; run it again once that one finishes",
	],
	/* Atlas's driver requires TLS where a URL names no sslmode, as comb's own reads now do */
	[
		/SSL is not enabled on the server/,
		"the server takes no TLS, which Atlas and comb require where a URL names no sslmode; set sslmode=disable on the URL of a server without TLS",
	],
]

/**
 * Atlas's failure in comb's terms where comb knows the fix, else as Atlas said it; `scrub` takes only
 * the text Atlas wrote, never comb's words. `devOnly` for a call that gave Atlas the dev database
 * alone (migrate diff), whose "not clean" can only be the dev database's
 */
function explainAtlasFailure(
	stderr: string,
	scrub: (text: string) => string,
	{ devOnly = false }: { devOnly?: boolean | undefined } = {},
): string {
	const fixed = FIXED.find(([said]) => said.test(stderr))
	if (fixed !== undefined) return fixed[1]
	const unclean = notClean(stderr, scrub, devOnly)
	if (unclean !== undefined) return unclean
	/* Atlas is scoped to the schema and inspects it before anything runs, so no migration can create it */
	const missing = scrub(/schema "([^"]+)" was not found/.exec(stderr)?.[1] ?? "")
	if (missing !== "")
		return `schema ${missing} does not exist on the target; create it once (CREATE SCHEMA ${missing}) before the first apply`
	const [, value, type] = /dropping value "([^"]*)" from enum "([^"]*)" is not supported/.exec(stderr) ?? []
	if (value !== undefined) {
		return `Atlas cannot drop the value "${scrub(value)}" of enum "${scrub(type as string)}": write that migration by hand (a new type without it, the columns moved to it, the old type dropped), then run migrate diff again`
	}
	const refused = /(\w[\w ]*?) (?:is|are) available to logged-in users only/.exec(stderr)?.[1]
	return refused === undefined
		? scrub(stderr)
		: `Atlas OSS does not diff ${scrub(refused.replace(/^Error: /, ""))}: take them out of the drizzle schema and write their migration by hand, or use Atlas Pro`
}

export { explainAtlasFailure, failedStatement, NOT_CLEAN }
