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
import { postgresOptionsOf } from "./pg-url.ts"
import { maskSecrets } from "./atlas-secrets.ts"
import { sequenceLabel } from "./pg-catalog-kinds.ts"
import { CATALOG } from "./pg-live-catalog.ts"
import type { LiveObjects, LiveTarget } from "./pg-live-types.ts"
import type { Facts } from "./pg-nodes.ts"

/** The postgres.js client, as far as comb uses it */
type Sql = { end(): Promise<void>; unsafe(query: string, params: unknown[]): Promise<Array<Record<string, unknown>>> }
type Connect = (options: Record<string, unknown>) => Sql

/* the optional peer and the range comb is tested against */
const PEER = "postgres"
const RANGE = ">=3.4.9 <4"

/**
 * What a postgres.js failure says: its message, or, for the AggregateError it throws with none when
 * every address refuses, each address's answer joined (P15 of the 0.15.0 review)
 */
function failureOf(error: unknown, field?: "devUrl" | "url"): string {
	const { errors, message } = error as { errors?: unknown; message?: unknown }
	const said =
		typeof message === "string" && message !== ""
			? message
			: Array.isArray(errors)
				? errors.map((each) => String((each as { message?: unknown }).message)).join("; ")
				: ""
	/* P19 of r18: a server without TLS ends the handshake comb's require starts */
	if (field === undefined || !said.includes("before secure TLS connection was established")) return said
	return `${said}: the server takes no TLS, which comb and Atlas require where ${field} names no sslmode; set sslmode=disable on ${field} for a server without TLS`
}

/** postgres.js, or the refusal naming it and `why` comb needs it here */
async function loadPostgres(why: string): Promise<Connect> {
	const specifier: string = PEER
	try {
		return ((await import(specifier)) as { default: Connect }).default
	} catch (error) {
		throw new Error(`${why}; install ${PEER} (${RANGE}), an optional peer, and run it again`, { cause: error })
	}
}

/** What a baseline compares itself, as its refusals name it */
const COMPARED =
	"functions, triggers, views, sequences, policies, types, rules, collations, extensions and row level security"

/* why a baseline loads it: it cannot vouch for the database without it */
const COMPARES = `baseline compares the database's ${COMPARED}, which Atlas OSS does not, through the ${PEER} package`

/** `row` of the catalog read, into `live` */
function readRow(row: Record<string, unknown>, live: LiveObjects): void {
	const [name, table, how] = [String(row["name"]), String(row["on_table"]), String(row["how"])]
	const what = row["what"]
	if (what === "relation") {
		live.relations.set(name, row["kind"] as "materialized view" | "sequence" | "view")
		if (row["kind"] === "sequence") live.sequences.set(name, how)
	} else if (what === "policy") live.policies.set(table, (live.policies.get(table) ?? new Map()).set(name, how))
	else if (what === "routine") {
		const kind = row["kind"] as "function" | "procedure"
		const routine = live.routines.get(name) ?? { kind, signatures: new Set<string>() }
		live.routines.set(name, { kind, signatures: routine.signatures.add(String(row["signature"])) })
	} else if (what === "kind")
		live.kinds.set(name, row["kind"] as "collation" | "composite type" | "domain" | "range type")
	else if (what === "rule") live.rules.set(table, (live.rules.get(table) ?? new Set()).add(name))
	else if (what === "rls") live.rls.set(name, how)
	else if (what === "extension") live.extensions.add(name)
	else if (what === "user") live.user = name
	else {
		const fired = { enabled: row["enabled"] === true, type: Number(row["tgtype"]) }
		live.triggers.set(table, (live.triggers.get(table) ?? new Map()).set(name, fired))
	}
}

/** What the target schema of `target`'s database holds of what Atlas OSS does not compare; it writes nothing */
async function readLiveObjects(
	target: LiveTarget,
	load: () => Promise<Connect> = () => loadPostgres(COMPARES),
): Promise<LiveObjects> {
	const connect = await load()
	const sql = connect({ ...postgresOptionsOf(target.url, "url"), max: 1 })
	try {
		const rows = await sql.unsafe(CATALOG, [target.schema])
		const live: LiveObjects = {
			extensions: new Set(),
			kinds: new Map(),
			policies: new Map(),
			relations: new Map(),
			rls: new Map(),
			routines: new Map(),
			rules: new Map(),
			sequences: new Map(),
			triggers: new Map(),
			user: "",
		}
		for (const row of rows) readRow(row, live)
		return live
	} catch (error) {
		throw new Error(
			`comb could not read the database's ${COMPARED}: ${maskSecrets(failureOf(error, "url"), [target.url])}`,
			{
				cause: error,
			},
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

/**
 * Each trigger's label, by name, table and how it fires; each view, sequence, policy, type, rule and
 * table's row level security, by what it is, its name, and its settings where comb compares them
 */
function labels(live: LiveObjects): { objects: Set<string>; triggers: Set<string> } {
	const out = { objects: new Set<string>(), triggers: new Set<string>() }
	for (const [table, each] of live.triggers)
		for (const [name, how] of each) out.triggers.add(`trigger ${name} on ${table} (${fires(how)})`)
	for (const [name, kind] of live.relations)
		out.objects.add(
			kind === "sequence" ? `sequence ${name} (${live.sequences.get(name) as string})` : `${kind} ${name}`,
		)
	for (const [table, each] of live.policies)
		for (const [name, how] of each) out.objects.add(`policy ${name} on ${table} (${how})`)
	for (const [name, kind] of live.kinds) out.objects.add(`${kind} ${name}`)
	for (const [table, each] of live.rules) for (const name of each) out.objects.add(`rule ${name} on ${table}`)
	for (const [table, how] of live.rls) out.objects.add(`row level security on ${table} (${how})`)
	return out
}

/** The labels only one side has, each saying which */
const onlyIn = (database: ReadonlySet<string>, migrations: ReadonlySet<string>): string[] => [
	...[...database].filter((label) => !migrations.has(label)).map((label) => `${label}: only in the database`),
	...[...migrations].filter((label) => !database.has(label)).map((label) => `${label}: only in the migrations`),
]

/** `map`'s entries keyed in the target schema: a key with no schema part (M72) */
const here = <T>(map: Map<string, T>): Array<[string, T]> => [...map].filter(([key]) => !key.includes("."))

/** What the history leaves in the target schema, keyed as the catalog names it: a key with no schema part (M72) */
function historyObjects(facts: Facts, user: string): LiveObjects {
	/* Postgres keeps no array dimensions in a signature: int[][] is int[] */
	const routines = new Map(
		[...facts.routines]
			.filter(([key]) => !key.includes("."))
			.map(([key, { kind, signatures }]) => {
				const flat = new Set([...signatures.keys()].map((signature) => signature.replaceAll(/(?:\[\])+/g, "[]")))
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
	const relations = new Map(
		[...facts.relations].flatMap(([key, kind]) =>
			key.includes(".") || kind === "owned sequence" ? [] : [[key, kind] as const],
		),
	)
	const policies = new Map(
		here(facts.policies).map(([table, each]) => [
			table,
			new Map(
				[...each].map(([name, { cmd, permissive, roles }]) => [name, policyHow(cmd, as(roles, user), permissive)]),
			),
		]),
	)
	const sequences = new Map(
		here(facts.sequences).flatMap(([key, settings]) =>
			relations.has(key) ? [[key, sequenceLabel(settings)] as const] : [],
		),
	)
	const rls = new Map(here(facts.rls).map(([table, { enabled, forced }]) => [table, rlsHow(enabled, forced)]))
	return {
		extensions: new Set(facts.extensions),
		kinds: new Map(here(facts.kinds)),
		policies,
		relations,
		rls,
		routines,
		rules: new Map(here(facts.rules)),
		sequences,
		triggers,
		user,
	}
}

// lookup-table: the role keywords a policy may name that stand for the role the migrations ran as
const RAN_AS: ReadonlySet<string> = /* @__PURE__ */ new Set(["current_role", "current_user", "session_user"])

/** `roles` with CURRENT_USER and its like read as `user`, the role baseline connects as, as Postgres stored it (R2 of plan 17) */
const as = (roles: readonly string[], user: string): string[] =>
	[...new Set(roles.map((role) => (RAN_AS.has(role) ? user : role)))].sort()

/** A policy's settings as the catalog read spells them: `for all, to public, permissive` */
const policyHow = (cmd: string, roles: readonly string[], permissive: boolean): string =>
	`for ${cmd}, to ${roles.join(", ")}, ${permissive ? "permissive" : "restrictive"}`

/** A table's row level security as the catalog read spells it: `enabled, not forced` */
const rlsHow = (enabled: boolean, forced: boolean): string =>
	`${enabled ? "enabled" : "disabled"}, ${forced ? "forced" : "not forced"}`

/**
 * What the database and the history disagree on, by name and signature or how a trigger fires:
 * each object only one of them has, and how many of each kind they share, whose bodies neither
 * comparison read
 */
function liveDrift(
	facts: Facts,
	live: LiveObjects,
): { matched: { routines: number; triggers: number; views: number }; only: string[] } {
	const history = historyObjects(facts, live.user)
	const routines = routineDrift(live.routines, history.routines)
	const [database, migrations] = [labels(live), labels(history)]
	/* an extension the database alone has may be the platform's own: only a missing one refuses */
	const extensions = [...history.extensions]
		.filter((name) => !live.extensions.has(name))
		.map((name) => `extension ${name}: only in the migrations`)
	const only = [
		...routines.only,
		...onlyIn(database.triggers, migrations.triggers),
		...onlyIn(database.objects, migrations.objects),
		...extensions,
	]
	const triggers = [...database.triggers].filter((label) => migrations.triggers.has(label)).length
	const views = [...live.relations.entries()].filter(
		([name, kind]) => kind !== "sequence" && history.relations.get(name) === kind,
	).length
	return { matched: { routines: routines.matched, triggers, views }, only: only.sort() }
}

/**
 * Whether the catalog's spelling of an argument type is the history's: the same; the type name
 * alone where the history left the type to the search path, which the catalog qualifies; or any
 * type for a `%TYPE`, whose column the history's facts hold no type for
 */
function argumentMatches(database: string, migrations: string): boolean {
	if (migrations.endsWith("%TYPE") || database === migrations) return true
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

export { COMPARED, type Connect, failureOf, liveDrift, loadPostgres, readLiveObjects }
