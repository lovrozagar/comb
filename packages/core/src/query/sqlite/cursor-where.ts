/**
 * The keyset predicate a SQLite list resumes after: the cursor opened under the list's options and
 * sort, each value checked against its key, bound as every driver binds it, and a value carried by
 * reference read from `table`'s row (a derived list, with no table, takes none).
 */
import type { SQL } from "drizzle-orm"
import type { SQLiteTable } from "drizzle-orm/sqlite-core"

import { type CursorId, type CursorOptions, readCursor } from "../cursor.ts"
import { anchored, assertNoReference } from "../cursor-ref.ts"
import type { SortField } from "../types.ts"
import { assertCursorFits, bindable, boundForKeys, exactSeconds, inSeconds } from "./cursor-fit.ts"
import { keysetSQL, type SortKey } from "./keyset.ts"

/** What resuming after a cursor needs: it, how it was sealed, the sort, the keys, and the table */
type CursorWhere = {
	cursor: string
	keys: readonly SortKey[]
	options: CursorOptions
	sort: readonly SortField[]
	table: SQLiteTable | undefined
	tiebreak: SortKey
}

/** The rows after `cursor`, as a predicate; a 400 for a cursor its keys cannot take */
function cursorWhere({ cursor: given, keys, options, sort, table, tiebreak }: CursorWhere): SQL {
	const cursor = readCursor(given, sort, options)
	if (table === undefined) assertNoReference(cursor.values)
	const columns = keys.map(({ column }) => column)
	assertCursorFits([...columns, tiebreak.column], [...cursor.values, cursor.id])
	const id = bindable(cursor.id) as CursorId
	const bound = boundForKeys(columns, cursor.values)
	/* a list with no table binds a seconds-mode timestamp to the millisecond; one with a table reads it from the row */
	const values =
		table === undefined
			? bound.map((value, i) => (value instanceof Date && inSeconds(columns[i]) ? exactSeconds(value) : value))
			: anchored(keys, bound, { id, nonFinite: options.nonFinite, table, tiebreak: tiebreak.column })
	return keysetSQL({ id, keys, tiebreak, values })
}

export { cursorWhere }
