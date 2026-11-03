/**
 * An integer sort key a driver read as a number past ±(2^53 − 1) is already rounded. A list that binds
 * the key as read cannot page it: a derived list with no anchor row to read the exact key back from
 * (Q1 of r19), and a merged list, whose shards' keys that round to one double compare equal (Q2 of r18).
 * A SQLite REAL and a Postgres double precision are doubles, so one past 2^53 is exact: the key's class,
 * which the builder selects as `_combKeyTypes`, decides (Q1 of r20, Q2 of r21), and only where none was
 * selected does the value alone.
 */
import { CombError } from "../error.ts"
import { combErrorKeys } from "../types.ts"
import { storedClasses } from "./list-extras.ts"
import type { SortField } from "./types.ts"

// lookup-table: why a list cannot page an integer sort key the driver rounded, by the list
const ROUNDED: Readonly<Record<"derived" | "merged", string>> = {
	derived:
		"a derived list has no row to read the exact key back from, so its integer sort keys must be within ±(2^53 − 1), or be read as bigint",
	merged: "a merged list's integer sort keys must be within ±(2^53 − 1), or be read as bigint",
}

/**
 * The 500 for `row`'s first integer sort key past ±(2^53 − 1), which the driver rounded, on a list
 * that cannot page it (Q2 of r18, Q1 of r19); none where every key is exact. A bigint is exact, and
 * so is a number SQLite stored as a REAL (Q1 of r20) or Postgres typed a double precision or real (Q2 of r21).
 */
function roundedKey(
	row: Record<string, unknown>,
	sort: readonly SortField[],
	kind: "derived" | "merged",
): CombError | undefined {
	const stored = storedClasses(row)
	const rounded = sort.find(({ field }, i) => {
		const value = row[field]
		const integer = stored === undefined || stored[i] === "integer" || stored[i] === "fixed"
		return integer && typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value)
	})
	if (rounded === undefined) return undefined
	return new CombError({
		cause: `${rounded.field} ${BigInt(row[rounded.field] as number)} is past ±(2^53 − 1), where the driver rounded it: ${ROUNDED[kind]}`,
		errorKey: combErrorKeys.SORT_NOT_WIRED,
		status: "internal_server_error",
	})
}

export { roundedKey }
