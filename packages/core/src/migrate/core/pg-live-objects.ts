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

/** Each routine's label, by kind, name and arguments, `function f(int4)`; and each trigger's, by name, table and how it fires */
function labels({ routines, triggers }: LiveObjects): { routines: Set<string>; triggers: Set<string> } {
	const out = { routines: new Set<string>(), triggers: new Set<string>() }
	for (const [name, { kind, signatures }] of routines)
		for (const signature of signatures) out.routines.add(`${kind} ${name}(${signature})`)
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
	const [database, migrations] = [labels(live), labels(historyObjects(facts))]
	const only: string[] = []
	const matched = { routines: 0, triggers: 0 }
	for (const kind of ["routines", "triggers"] as const) {
		for (const label of database[kind]) {
			if (migrations[kind].has(label)) matched[kind]++
			else only.push(`${label}: only in the database`)
		}
		for (const label of migrations[kind]) if (!database[kind].has(label)) only.push(`${label}: only in the migrations`)
	}
	return { matched, only: only.sort() }
}

export { type Connect, liveDrift, loadPostgres, readLiveObjects }
