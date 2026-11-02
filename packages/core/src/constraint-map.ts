/**
 * Looking a constraint violation up in the app's ConstraintMaps, shared by the SQLite and the
 * Postgres handlers: each dialect finds the table, column or constraint name its own way, and
 * both turn what they found into the same CombError.
 */
import { CombError } from "./error.ts"
import { warnOnError } from "./log.ts"
import type { ConstraintMap, ConstraintMapEntry, StatusKey } from "./types.ts"

export type TableMap = NonNullable<ConstraintMap[string]>

/** The generic error for a kind of violation, used when no map entry matches. */
export type Fallback = { cause: string; errorKey: string; status: StatusKey }

/** What a handler found: the map entry, if any, the generic error otherwise, and where. */
export type Found = {
	column?: string | undefined
	entry: ConstraintMapEntry | undefined
	fallback: Fallback
	table?: string | undefined
}

/** `record[key]` when `key` is the record's own (never an inherited name such as `constructor`). */
export const own = <T>(record: Record<string, T> | undefined, key: string | undefined): T | undefined =>
	record !== undefined && key !== undefined && Object.hasOwn(record, key) ? record[key] : undefined

/**
 * The entry `map` holds for `table`: its own key's, else that of the longest prefix pattern it
 * starts with, a key ending in `*` (`"ut_*"`), which keys the tables an app makes at run time and
 * no generated map can name (R5 of plan 17). A key with a `*` anywhere else matches nothing
 */
export function entryOf(map: ConstraintMap, table: string | undefined): TableMap | undefined {
	let pattern: string | undefined
	for (const key of Object.keys(map)) {
		/* a malformed key matches nothing: defineConstraintMaps refuses it at load, and checkedOnce reports it (Q4 of r19) */
		if (!key.endsWith("*") || malformed(key)) continue
		if (table?.startsWith(key.slice(0, -1)) === true && key.length > (pattern?.length ?? 0)) pattern = key
	}
	if (table !== undefined && Object.hasOwn(map, table)) return map[table]
	return pattern === undefined ? undefined : map[pattern]
}

/** Whether `key` holds a `*` anywhere but its end, which no prefix pattern does */
const malformed = (key: string): boolean => key.includes("*") && key.indexOf("*") !== key.length - 1

/** Why `key` is no key a map may hold */
const ruleOf = (key: string): string =>
	`constraint map key "${key}": a "*" may only end a key, as a prefix pattern such as "ut_*"`

// lookup-table: the maps defineConstraintMaps checked, or whose malformed keys were reported once: each map, not its array, which an app may build per call (Q5 of r20)
const CHECKED: WeakSet<ConstraintMap> = /* @__PURE__ */ new WeakSet()

/**
 * The maps an app passes its error handlers, every key checked where it builds them, at module load:
 * a TypeError naming a key with a `*` anywhere but its end, never a lookup at the first violation
 * (Q4 of r19). The array comes back frozen, and no handler checks it again.
 */
export function defineConstraintMaps(...maps: ConstraintMap[]): readonly ConstraintMap[] {
	const bad = maps.flatMap((map) => Object.keys(map)).find(malformed)
	if (bad !== undefined) throw new TypeError(ruleOf(bad))
	for (const map of maps) CHECKED.add(map)
	return Object.freeze(maps)
}

/**
 * `maps`, a handler's first look at each map reporting its malformed keys once to the operator, through
 * the warn sink, however many arrays carry it: the violation is still classified with the well-formed
 * keys, as the client's answer must not change, nor say anything of the app's configuration (Q4 of r19)
 */
export function checkedOnce(maps: readonly ConstraintMap[]): readonly ConstraintMap[] {
	for (const map of maps) {
		if (CHECKED.has(map)) continue
		CHECKED.add(map)
		for (const key of Object.keys(map).filter(malformed))
			warnOnError("comb.constraint-maps.error", {
				key,
				message: `${ruleOf(key)}; it matches no table. Build the maps with defineConstraintMaps, which refuses such a key at load`,
			})
	}
	return maps
}

/** Whether a map lists `column` among `table`'s private columns */
const listsPrivate = (maps: readonly ConstraintMap[], table: string | undefined, column: string) =>
	maps.some((map) => entryOf(map, table)?.private?.includes(column) === true)

/**
 * Whether the maps can say which of `table`'s columns are private: no map is given, which hides
 * none, or one keys the table. Maps that key it nowhere cannot, as for a table a trigger writes
 * outside the schema, so its columns are hidden on every dialect (Q9 of r17, Q10 of r18)
 */
const knows = (maps: readonly ConstraintMap[], table: string | undefined) =>
	maps.length === 0 || table === undefined || maps.some((map) => entryOf(map, table) !== undefined)

/**
 * The columns an error may name of those a violation reports: all of them, or none when a map lists
 * one as the table's private column, since naming the rest would point at it (F67), or when the
 * maps given key no such table (fail closed)
 */
export function shown(
	maps: readonly ConstraintMap[],
	table: string | undefined,
	columns: readonly string[],
): readonly string[] {
	if (!knows(maps, table)) return []
	return columns.some((column) => listsPrivate(maps, table, column)) ? [] : columns
}

/** `column`, or undefined when a map lists it among `table`'s private columns (F67), or shown hides the table's */
export const shownColumn = (
	maps: readonly ConstraintMap[],
	table: string | undefined,
	column: string | undefined,
): string | undefined => (column === undefined ? undefined : shown(maps, table, [column])[0])

/** The first entry `pick` finds for `table` across `maps`. */
export function lookup(
	maps: readonly ConstraintMap[],
	table: string | undefined,
	pick: (t: TableMap) => ConstraintMapEntry | undefined,
): ConstraintMapEntry | undefined {
	for (const map of maps) {
		const t = entryOf(map, table)
		const entry = t === undefined ? undefined : pick(t)
		if (entry !== undefined) return entry
	}
	return undefined
}

/** The `kind` entry named `name` (a CHECK, or a unique index) in any table, with that table. */
export function findNamed(
	maps: readonly ConstraintMap[],
	kind: "check" | "unique",
	name: string | undefined,
): { entry: ConstraintMapEntry; table: string } | undefined {
	for (const map of maps) {
		for (const [table, t] of Object.entries(map)) {
			/* a pattern names no one table: its constraints are found through the violated table's */
			if (table.endsWith("*")) continue
			const entry = own(t[kind], name)
			if (entry !== undefined) return { entry, table }
		}
	}
	return undefined
}

/** The CombError for what a handler found; `source` is the original error, kept for logs. */
export function toCombError({ column, entry, fallback, table }: Found, source: unknown): CombError {
	if (entry === undefined) return new CombError({ ...fallback, column, source, table })
	const status = entry.statusKey ?? (fallback.status === "bad_request" ? "bad_request" : "conflict")
	return new CombError({ cause: entry.cause, column, errorKey: entry.errorKey, source, status, table })
}
