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
 * through pg_depend), each with its input argument types as the parser spells them (the catalog's
 * type name, an array as its element's and [], the schema left out for pg_catalog and the
 * target's), and its tables' triggers but the internal ones a constraint makes, with tgtype and
 * whether they fire: O and A do, D and R (replica only) do not, as the history reads ENABLE and
 * DISABLE (P13)
 */
const CATALOG = `SELECT 'routine' AS what, p.proname AS name, CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END AS kind, NULL AS on_table,
(SELECT coalesce(string_agg(CASE WHEN tn.nspname IN ('pg_catalog', $1) THEN '' ELSE tn.nspname || '.' END || t.typname || CASE WHEN x.arr THEN '[]' ELSE '' END, ',' ORDER BY a.ord), '')
 FROM unnest(p.proargtypes::oid[]) WITH ORDINALITY AS a(oid, ord)
 JOIN pg_catalog.pg_type at ON at.oid = a.oid
 CROSS JOIN LATERAL (SELECT at.typcategory = 'A' AND at.typelem <> 0 AS arr) x
 JOIN pg_catalog.pg_type t ON t.oid = CASE WHEN x.arr THEN at.typelem ELSE at.oid END
 JOIN pg_catalog.pg_namespace tn ON tn.oid = t.typnamespace) AS signature,
NULL::int AS tgtype, NULL::boolean AS enabled
FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = $1 AND p.prokind IN ('f', 'p')
AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid = 'pg_catalog.pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
UNION ALL
SELECT 'trigger', t.tgname, NULL, c.relname, NULL, t.tgtype::int, t.tgenabled IN ('O', 'A')
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
			if (row["what"] === "routine") {
				const kind = row["kind"] as "function" | "procedure"
				const routine = live.routines.get(name) ?? { kind, signatures: new Set<string>() }
				live.routines.set(name, { kind, signatures: routine.signatures.add(String(row["signature"])) })
			} else {
				const table = String(row["on_table"])
				const how = { enabled: row["enabled"] === true, type: Number(row["tgtype"]) }
				live.triggers.set(table, (live.triggers.get(table) ?? new Map()).set(name, how))
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

// lookup-table: tgtype's event bits, in the order Postgres writes them
const EVENT_BITS: ReadonlyArray<[number, string]> = [
	[4, "insert"],
	[8, "delete"],
	[16, "update"],
	[32, "truncate"],
]

/** When and for what a trigger of `type` (tgtype) fires, and whether it does: `before insert, for each row` */
function fires({ enabled, type }: { enabled: boolean; type: number }): string {
	const timing = (type & 2) !== 0 ? "before" : (type & 64) !== 0 ? "instead of" : "after"
	const events = EVENT_BITS.filter(([bit]) => (type & bit) !== 0).map(([, event]) => event)
	return `${timing} ${events.join(" or ")}, for each ${(type & 1) !== 0 ? "row" : "statement"}${enabled ? "" : ", disabled"}`
}

/** Each trigger's label, by name, table and how it fires */
function labels({ triggers }: LiveObjects): { triggers: Set<string> } {
	const out = { triggers: new Set<string>() }
	for (const [table, each] of triggers)
		for (const [name, how] of each) out.triggers.add(`trigger ${name} on ${table} (${fires(how)})`)
	return out
}

/** What the history leaves in the target schema, keyed as the catalog names it: a key with no schema part (M72) */
function historyObjects(facts: Facts): LiveObjects {
	/* Postgres keeps no array dimensions in a signature: int[][] is int[] */
	const routines = new Map(
		[...facts.routines]
			.filter(([key]) => !key.includes("."))
			.map(([key, { kind, signatures }]) => {
				const flat = new Set([...signatures].map((signature) => signature.replaceAll(/(?:\[\])+/g, "[]")))
				return [key, { kind, signatures: flat }] as const
			}),
	)
	const triggers = new Map(
		[...facts.triggers]
			.filter(([table, each]) => !table.includes(".") && each.length > 0)
			.map(
				([table, each]) => [table, new Map(each.map(({ enabled, name, type }) => [name, { enabled, type }]))] as const,
			),
	)
	return { routines, triggers }
}

/**
 * What the database and the history disagree on, by name and signature or how a trigger fires:
 * each object only one of them has, and how many of each kind they share, whose bodies neither
 * comparison read
 */
function liveDrift(
	facts: Facts,
	live: LiveObjects,
): { matched: { routines: number; triggers: number }; only: string[] } {
	const history = historyObjects(facts)
	const routines = routineDrift(live.routines, history.routines)
	const [database, migrations] = [labels(live).triggers, labels(history).triggers]
	const only = [...routines.only]
	let triggers = 0
	for (const label of database) {
		if (migrations.has(label)) triggers++
		else only.push(`${label}: only in the database`)
	}
	for (const label of migrations) if (!database.has(label)) only.push(`${label}: only in the migrations`)
	return { matched: { routines: routines.matched, triggers }, only: only.sort() }
}

/**
 * Whether the catalog's spelling of an argument type is the history's: the same, or the type name
 * alone where the history left the type to the search path, which the catalog qualifies
 */
function argumentMatches(database: string, migrations: string): boolean {
	if (database === migrations) return true
	return !migrations.includes(".") && database.slice(database.lastIndexOf(".") + 1) === migrations
}

/** Whether two signatures name one overload: as many arguments, each matching */
function signatureMatches(database: string, migrations: string): boolean {
	const [ours, theirs] = [database.split(","), migrations.split(",")]
	return ours.length === theirs.length && ours.every((each, i) => argumentMatches(each, theirs[i] as string))
}

/** Each routine's overloads paired across the two sides by kind and signature, as `function f(int4)` labels the rest */
function routineDrift(
	database: LiveObjects["routines"],
	migrations: LiveObjects["routines"],
): { matched: number; only: string[] } {
	const out = { matched: 0, only: [] as string[] }
	for (const name of new Set([...database.keys(), ...migrations.keys()])) {
		const [ours, theirs] = [database.get(name), migrations.get(name)]
		const left = ours === undefined ? [] : [...ours.signatures]
		for (const signature of theirs?.signatures ?? []) {
			const at = ours?.kind === theirs?.kind ? left.findIndex((each) => signatureMatches(each, signature)) : -1
			if (at === -1) out.only.push(`${theirs?.kind} ${name}(${signature}): only in the migrations`)
			else {
				left.splice(at, 1)
				out.matched++
			}
		}
		for (const signature of left) out.only.push(`${ours?.kind} ${name}(${signature}): only in the database`)
	}
	return out
}

export { type Connect, liveDrift, loadPostgres, readLiveObjects }
