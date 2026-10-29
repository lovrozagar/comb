/**
 * The keyset predicate a SQLite list resumes after: the cursor opened under the list's options and
 * sort, each value checked against its key, bound as every driver binds it, and a value carried by
 * reference read from `table`'s row (a derived list, with no table, takes none).
 */
import type { SQL } from "drizzle-orm"
import type { SQLiteTable } from "drizzle-orm/sqlite-core"

import { CombError } from "../../error.ts"
import { combErrorKeys } from "../../types.ts"
import { type CursorId, type CursorOptions, CursorRef, readCursor } from "../cursor.ts"
import { anchored, assertNoReference } from "../cursor-ref.ts"
import type { SortField } from "../types.ts"
import { assertCursorFits, bindable, boundForKeys, exactSeconds, inSeconds } from "./cursor-fit.ts"
import { anchorGone, keysetSQL, type SortKey } from "./keyset.ts"

/** What resuming after a cursor needs: it, how it was sealed, the sort, the keys, and the table */
type CursorWhere = {
	cursor: string
	keys: readonly SortKey[]
	/** a merged list's, which mints no reference: one that carries one is no cursor of it (R1 of plan 16's review) */
	merged?: boolean | undefined
	options: CursorOptions
	sort: readonly SortField[]
	table: SQLiteTable | undefined
	tiebreak: SortKey
}

/**
 * The rows after `cursor`, as a predicate, and the flag that says its anchor is gone where no bound
 * is safe (undefined when no bound can be); a 400 for a cursor its keys cannot take
 */
function cursorWhere({ cursor: given, keys, merged, options, sort, table, tiebreak }: CursorWhere): {
	gone: SQL | undefined
	where: SQL
} {
	const cursor = readCursor(given, sort, options)
	if (merged === true && cursor.values.some((value) => value instanceof CursorRef)) {
		throw new CombError({
			cause:
				"a merged list's cursor carries no reference, as only one shard holds the row it names; this cursor is another list's",
			errorKey: combErrorKeys.INVALID_CURSOR,
			status: "bad_request",
		})
	}
	if (table === undefined) assertNoReference(cursor.values)
	const columns = keys.map(({ column }) => column)
	assertCursorFits([...columns, tiebreak.column], [...cursor.values, cursor.id], table)
	const id = bindable(cursor.id) as CursorId
	const bound = boundForKeys(columns, cursor.values)
	/* a list with no table binds a seconds-mode timestamp to the millisecond; one with a table reads it from the row */
	const values =
		table === undefined
			? bound.map((value, i) => (value instanceof Date && inSeconds(columns[i]) ? exactSeconds(value) : value))
			: anchored(keys, bound, { id, nonFinite: options.nonFinite, table, tiebreak: tiebreak.column })
	return { gone: anchorGone(values), where: keysetSQL({ id, keys, tiebreak, values }) }
}

export { cursorWhere }
