/**
 * An integer sort key a driver read as a number past ±(2^53 − 1) is already rounded. A list that binds
 * the key as read cannot page it: a derived list with no anchor row to read the exact key back from,
 * and a merged list, whose shards' keys that round to one double compare equal.
 * A SQLite REAL and a Postgres double precision are doubles, so one past 2^53 is exact: the key's class,
 * which the builder selects as `_combKeyTypes`, decides, and only where none was
 * selected does the value alone. A class is trusted only when it names a double, so one comb cannot
 * place, such as a type no family covers, is refused as an integer is.
 */
import { CombError } from "../error.ts"
import { combErrorKeys } from "../types.ts"
import { storedClasses } from "./list-extras.ts"
import type { SortField } from "./types.ts"

// lookup-table: why a list cannot page an integer sort key the driver rounded, by the list
const ROUNDED: Readonly<Record<"derived" | "merged" | "unread", string>> = {
	derived:
		"a derived list has no row to read the exact key back from, so its integer sort keys must be within ±(2^53 − 1), or be read as bigint",
	merged: "a merged list's integer sort keys must be within ±(2^53 − 1), or be read as bigint",
	unread:
		"the key is no column of the anchor table, nor an expression over its columns alone, so no row reads the exact key back: sort by a column of the anchor table, keep it within ±(2^53 − 1), or read it as bigint",
}

// lookup-table: why a list cannot page a fraction the driver may have rounded, by the list
const FRACTION: Readonly<Record<"derived" | "merged" | "unread", string>> = {
	derived: "a derived list has no row to read the exact key back from",
	merged: "a merged list compares the keys as the driver read them",
	unread: "the key is no column of the anchor table, so no row reads the exact key back",
}

/**
 * The 500 for `row`'s first sort key the driver may have rounded, on a list that cannot page it:
 * every key of a derived or a merged list, and of an anchored list the keys
 * `unread` names, which its anchor row doesn't supply; none where every such key is
 * exact. A bigint, a safe integer and ±Infinity or NaN are exact, and so is a number SQLite stored
 * as a REAL or Postgres typed a double precision or real. Under any other
 * class, an integer past ±(2^53 − 1) is not, and so is a fraction, but under an
 * integer or a fixed class: no driver reads an integer type as a fraction, so one there is the app's
 * mapper's, a customType in cents, which the cursor binds back through its `toDriver`.
 * A Postgres numeric, the one fixed type that holds a fraction, carries its text instead
 * (`_combKeyTexts`), so no number of one reaches here; with no class, only the integer is known
 * rounded.
 */
function roundedKey(
	row: Record<string, unknown>,
	sort: readonly SortField[],
	list: "derived" | "merged" | { unread: (field: string) => boolean },
): CombError | undefined {
	const [kind, judged] = typeof list === "string" ? [list, () => true] : (["unread", list.unread] as const)
	const stored = storedClasses(row)
	const rounded = sort.find(({ field }, i) => {
		if (!judged(field)) return false
		const value = row[field]
		if (typeof value !== "number" || !Number.isFinite(value) || Number.isSafeInteger(value)) return false
		/* with no class, only an integer past 2^53 is known rounded; under one, any number but a double's may be */
		if (stored === undefined) return Number.isInteger(value)
		if (stored[i] === "real" || stored[i] === "float") return false
		/* no driver reads an integer type as a fraction: one under it is the app's mapper's, bound back through its toDriver */
		return Number.isInteger(value) || (stored[i] !== "integer" && stored[i] !== "fixed")
	})
	if (rounded === undefined) return undefined
	const value = row[rounded.field] as number
	return new CombError({
		cause: Number.isInteger(value)
			? `${rounded.field} ${BigInt(value)} is past ±(2^53 − 1), where the driver rounded it: ${ROUNDED[kind]}`
			: `${rounded.field} ${value} is a fraction under a type no driver reads exactly as a JS number, so the driver may have rounded it: ${FRACTION[kind]}: sort by a Postgres numeric, whose text comb carries, read the key as a string, or sort by a double precision or real`,
		errorKey: combErrorKeys.SORT_NOT_WIRED,
		status: "internal_server_error",
	})
}

export { roundedKey }
