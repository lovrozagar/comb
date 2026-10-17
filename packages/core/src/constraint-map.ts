/**
 * Looking a constraint violation up in the app's ConstraintMaps, shared by the SQLite and the
 * Postgres handlers: each dialect finds the table, column or constraint name its own way, and
 * both turn what they found into the same CombError.
 */
import { CombError } from "./error.ts"
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

/** The first entry `pick` finds for `table` across `maps`. */
export function lookup(
	maps: ConstraintMap[],
	table: string | undefined,
	pick: (t: TableMap) => ConstraintMapEntry | undefined,
): ConstraintMapEntry | undefined {
	for (const map of maps) {
		const t = own(map, table)
		const entry = t === undefined ? undefined : pick(t)
		if (entry !== undefined) return entry
	}
	return undefined
}

/** The CHECK entry named `name` in any table, with that table. */
export function findCheck(
	maps: ConstraintMap[],
	name: string | undefined,
): { entry: ConstraintMapEntry; table: string } | undefined {
	for (const map of maps) {
		for (const [table, t] of Object.entries(map)) {
			const entry = own(t.check, name)
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
