/**
 * The keyset predicate a SQLite list resumes after: the cursor opened under the list's options and
 * sort, each value checked against its key, bound as every driver binds it, and a value carried by
 * reference read from `table`'s row (a derived list, with no table, takes none).
 */
import type { SQL, SQLWrapper } from "drizzle-orm"
import type { SQLiteTable } from "drizzle-orm/sqlite-core"

import { CombError } from "../../error.ts"
import { combErrorKeys } from "../../types.ts"
import { type CursorId, type CursorOptions, CursorRef, readCursor } from "../cursor.ts"
import { anchored, assertNoReference } from "../cursor-ref.ts"
import type { SortField } from "../types.ts"
import type { ListDialect } from "../list-dialect.ts"
import { assertCursorFits, bindableIn, boundAsRead, boundCarried, boundForKeys, readsBack } from "./cursor-fit.ts"
import { anchorGone, keysetSQL, type SortKey } from "./keyset.ts"

/** What resuming after a cursor needs: it, how it was sealed, the sort, the keys, and the table */
type CursorWhere = {
	cursor: string
	/** the list's, which binds each value (QL4 of r22b) */
	dialect: ListDialect
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
function cursorWhere({ cursor: given, dialect, keys, merged, options, sort, table, tiebreak }: CursorWhere): {
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
	/* a key no anchor row supplies binds as read: a list with no table, a joined table's key (QL1 of r22b), and
	   every key of a merged list, whose row is on one shard alone and which carries a seconds key's seconds (AB3) */
	const asRead = (i: number) =>
		i < columns.length && (merged === true || table === undefined || !readsBack(columns[i] as SQLWrapper, table))
	assertCursorFits([...columns, tiebreak.column], [...cursor.values, cursor.id], { asRead, table })
	const id = bindableIn(dialect, tiebreak.column, cursor.id) as CursorId
	const carried = cursor.values.map((value, i) => boundCarried(columns[i], value))
	const bound = boundForKeys(dialect, columns, carried).map((value, i) =>
		asRead(i) ? boundAsRead(columns[i], value) : value,
	)
	/* a key the row supplies reads its bound from the row where the cursor's value can't say it exactly */
	const values =
		table === undefined
			? bound
			: anchored(keys, bound, { id, nonFinite: options.nonFinite, table, tiebreak: tiebreak.column })
	return { gone: anchorGone(values), where: keysetSQL({ id, keys, tiebreak, values }) }
}

export { cursorWhere }
