/**
 * Whether a Postgres schema holds anything. Postgres records every object placed in a
 * schema as depending on it in pg_depend: tables, views, sequences, functions, procedures,
 * aggregates, types, domains, collations, operators, conversions, text search objects, statistics
 * objects and extensions alike. DROP SCHEMA ... RESTRICT reads the same record. So this one read
 * holds for every kind, those comb's catalog read names and those it does not, with no list of
 * kinds to keep. Default privileges set on the schema depend on it too, but they are a rule for
 * objects to come, no object in it: running a migration again over them changes nothing.
 */
import { type Connect, failureOf, loadPostgres } from "./pg-live-objects.ts"
import type { LiveTarget } from "./pg-live-types.ts"
import { postgresOptionsOf } from "./pg-url.ts"

/** How comb reads whether a schema holds anything: holdsAnything, unless a test says otherwise */
type ReadHeld = (target: LiveTarget) => Promise<boolean>

/* why comb loads postgres.js here */
const READS = "tell a schema beside public's shared history that holds nothing from one that holds what it ran"

/* any object depending on the schema named `$1` exactly, default privileges apart; none for a schema that does not exist */
const HELD = `SELECT EXISTS (
	SELECT FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_namespace n ON n.oid = d.refobjid
	WHERE d.refclassid = 'pg_catalog.pg_namespace'::regclass
		AND n.nspname = $1
		AND d.classid <> 'pg_catalog.pg_default_acl'::regclass
) AS held`

/** Whether `target`'s schema holds any object, of any kind; it writes nothing */
async function holdsAnything(
	target: LiveTarget,
	load: () => Promise<Connect> = () => loadPostgres(READS),
): Promise<boolean> {
	const connect = await load()
	let sql: ReturnType<Connect> | undefined
	try {
		sql = connect({ ...postgresOptionsOf(target.url, "url"), max: 1 })
		const [row] = await sql.unsafe(HELD, [target.schema])
		return row?.["held"] === true
	} catch (error) {
		throw new Error(
			`comb could not read what schema ${target.schema} holds: ${failureOf(error, { field: "url", url: target.url, urls: [target.url] })}`,
			{ cause: error },
		)
	} finally {
		await sql?.end()
	}
}

export { holdsAnything, type ReadHeld }
