/**
 * The functions, procedures and triggers a Postgres baseline compares itself, which Atlas OSS leaves
 * out of its comparison without a word (plan 14's 5.4b, probe 4): read from the database's catalog
 * by name, in the target schema, and set against those the history leaves (pg-routines.ts,
 * Facts.triggers). Their bodies are compared by neither: Atlas OSS cannot load them, and comb does
 * not read them.
 *
 * comb has no Postgres client of its own; this one read takes postgres.js, an optional peer, loaded
 * only here. Its specifier is a variable, so a project without it still compiles comb's source.
 */
import { maskSecrets } from "./atlas-secrets.ts"
import type { LiveObjects, LiveTarget } from "./pg-live-types.ts"
import type { Facts } from "./pg-nodes.ts"

/** The postgres.js client, as far as comb uses it */
type Sql = { end(): Promise<void>; unsafe(query: string, params: unknown[]): Promise<Array<Record<string, unknown>>> }
type Connect = (url: string, options: Record<string, unknown>) => Sql

/* the optional peer and the range comb is tested against */
const PEER = "postgres"
const RANGE = ">=3.4.9 <4"

/*
 * one round trip: the target schema's functions and procedures but an extension's (a member of it
 * through pg_depend), and its tables' triggers but the internal ones a constraint makes
 */
const CATALOG = `SELECT 'routine' AS what, p.proname AS name, CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END AS kind, NULL AS on_table
FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = $1 AND p.prokind IN ('f', 'p')
AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid = 'pg_catalog.pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
UNION ALL
SELECT 'trigger', t.tgname, NULL, c.relname
FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = $1 AND NOT t.tgisinternal`

/** postgres.js, or the refusal naming it and `why` comb needs it here */
async function loadPostgres(why: string): Promise<Connect> {
	const specifier: string = PEER
	try {
		return ((await import(specifier)) as { default: Connect }).default
	} catch (error) {
		throw new Error(`${why}; install ${PEER} (${RANGE}), an optional peer, and run it again`, { cause: error })
	}
}

/* why a baseline loads it: it cannot vouch for the database without it */
const COMPARES = `baseline compares the database's functions and triggers, which Atlas OSS does not, through the ${PEER} package`

/** What the target schema of `target`'s database holds of functions, procedures and triggers; it writes nothing */
async function readLiveObjects(
	target: LiveTarget,
	load: () => Promise<Connect> = () => loadPostgres(COMPARES),
): Promise<LiveObjects> {
	const connect = await load()
	const sql = connect(target.url, { max: 1 })
	try {
		const rows = await sql.unsafe(CATALOG, [target.schema])
		const live: LiveObjects = { routines: new Map(), triggers: new Map() }
		for (const row of rows) {
			const name = String(row["name"])
			if (row["what"] === "routine") live.routines.set(name, row["kind"] as "function" | "procedure")
			else {
				const table = String(row["on_table"])
				live.triggers.set(table, (live.triggers.get(table) ?? new Set()).add(name))
			}
		}
		return live
	} catch (error) {
		throw new Error(
			`comb could not read the database's functions and triggers: ${maskSecrets((error as Error).message, [target.url])}`,
			{ cause: error },
		)
	} finally {
		await sql.end()
	}
}

/** Each object's label, by what it is and where: `function f`, `trigger t_ai on t` */
function labels({ routines, triggers }: LiveObjects): Set<string> {
	const out = new Set<string>()
	for (const [name, kind] of routines) out.add(`${kind} ${name}`)
	for (const [table, names] of triggers) for (const name of names) out.add(`trigger ${name} on ${table}`)
	return out
}

/** What the history leaves in the target schema, keyed as the catalog names it: a key with no schema part (M72) */
function historyObjects(facts: Facts): LiveObjects {
	const routines = new Map(
		[...facts.routines].filter(([key]) => !key.includes(".")).map(([key, { kind }]) => [key, kind] as const),
	)
	const triggers = new Map(
		[...facts.triggers]
			.filter(([table, each]) => !table.includes(".") && each.length > 0)
			.map(([table, each]) => [table, new Set(each.map((trigger) => trigger.name))] as const),
	)
	return { routines, triggers }
}

/**
 * What the database and the history disagree on, by name: each object only one of them has, and
 * how many they share, whose bodies neither comparison read
 */
function liveDrift(facts: Facts, live: LiveObjects): { matched: number; only: string[] } {
	const [database, migrations] = [labels(live), labels(historyObjects(facts))]
	const only = [
		...[...database].filter((label) => !migrations.has(label)).map((label) => `${label}: only in the database`),
		...[...migrations].filter((label) => !database.has(label)).map((label) => `${label}: only in the migrations`),
	]
	return { matched: [...database].filter((label) => migrations.has(label)).length, only: only.sort() }
}

export { type Connect, liveDrift, loadPostgres, readLiveObjects }
