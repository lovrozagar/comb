/**
 * An integer sort key a driver read as a number past ±(2^53 − 1) is already rounded. A list that binds
 * the key as read cannot page it: a derived list with no anchor row to read the exact key back from
 * (Q1 of r19), and a merged list, whose shards' keys that round to one double compare equal (Q2 of r18).
 */
import { CombError } from "../error.ts"
import { combErrorKeys } from "../types.ts"
import type { SortField } from "./types.ts"

// lookup-table: why a list cannot page an integer sort key the driver rounded, by the list
const ROUNDED: Readonly<Record<"derived" | "merged", string>> = {
	derived:
		"a derived list has no row to read the exact key back from, so its integer sort keys must be within ±(2^53 − 1), or be read as bigint",
	merged: "a merged list's integer sort keys must be within ±(2^53 − 1), or be read as bigint",
}

/**
 * The 500 for `row`'s first integer sort key past ±(2^53 − 1), which the driver rounded, on a list
 * that cannot page it (Q2 of r18, Q1 of r19); none where every key is exact. A bigint is exact.
 */
function roundedKey(
	row: Record<string, unknown>,
	sort: readonly SortField[],
	kind: "derived" | "merged",
): CombError | undefined {
	const rounded = sort.find(({ field }) => {
		const value = row[field]
		return typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value)
	})
	if (rounded === undefined) return undefined
	return new CombError({
		cause: `${rounded.field} ${BigInt(row[rounded.field] as number)} is past ±(2^53 − 1), where the driver rounded it: ${ROUNDED[kind]}`,
		errorKey: combErrorKeys.SORT_NOT_WIRED,
		status: "internal_server_error",
	})
}

export { roundedKey }
