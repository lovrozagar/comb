/**
 * Atlas's failures in comb's terms, where comb knows the fix: Docker missing for the default dev
 * database, another apply's lock, a database with objects and no history (the target's, or the dev
 * database's, which Atlas finds as it snapshots it), a schema that is missing, a file out of order,
 * an enum value Atlas cannot drop, and what Atlas OSS refuses. Atlas's own text is scrubbed of
 * secrets; comb's words are never.
 */

/** comb's answer to a database Atlas calls not clean: objects but no history */
const NOT_CLEAN =
	"the database has objects but no migration history, and no shared history row matches this directory's files (a database made by hand, or another directory's history); if its schema matches the migrations, record them with comb migrate baseline"

/** Atlas's failure in comb's terms where comb knows the fix, else as Atlas said it; `scrub` takes only the text Atlas wrote, never comb's words */
function explainAtlasFailure(stderr: string, scrub: (text: string) => string): string {
	if (/Error: docker:|Cannot connect to the Docker daemon/i.test(stderr)) {
		return "Atlas needs Docker for the default devUrl (docker://postgres/17/dev); set devUrl to an empty Postgres database instead"
	}
	if (/lock is held by other session/.test(stderr)) {
		return "another migrate apply is running on this database; run it again once that one finishes"
	}
	/* Atlas snapshots the dev database before it replays on it: not clean there is the dev database's (P3 of the 0.15.0 review) */
	const [, held] =
		/taking database snapshot: .*?connected database is not clean: (?:found )?([^\n]*)/.exec(stderr) ?? []
	if (held !== undefined)
		return `devUrl must be an empty database, and it holds ${scrub(held.trim())}; point devUrl at an empty database, or empty this one`
	if (/connected database is not clean/.test(stderr)) return NOT_CLEAN
	/* Atlas is scoped to the schema and inspects it before anything runs, so no migration can create it (P15) */
	const missing = scrub(/schema "([^"]+)" was not found/.exec(stderr)?.[1] ?? "")
	if (missing !== "")
		return `schema ${missing} does not exist on the target; create it once (CREATE SCHEMA ${missing}) before the first apply`
	const late = /migration file (\S+) was added out of order/.exec(stderr)?.[1]
	if (late !== undefined) {
		return `${scrub(late)} is older than a migration already applied; rename it to a newer version and run atlas migrate hash`
	}
	const [, value, type] = /dropping value "([^"]*)" from enum "([^"]*)" is not supported/.exec(stderr) ?? []
	if (value !== undefined) {
		return `Atlas cannot drop the value "${scrub(value)}" of enum "${scrub(type as string)}": write that migration by hand (a new type without it, the columns moved to it, the old type dropped), then run migrate diff again`
	}
	const refused = /(\w[\w ]*?) (?:is|are) available to logged-in users only/.exec(stderr)?.[1]
	return refused === undefined
		? scrub(stderr)
		: `Atlas OSS does not diff ${scrub(refused.replace(/^Error: /, ""))}: take them out of the drizzle schema and write their migration by hand, or use Atlas Pro`
}

export { explainAtlasFailure, NOT_CLEAN }
