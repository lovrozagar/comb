/**
 * Minting a cursor that `readCursor` will open: one whose sealed length stays within
 * MAX_CURSOR_LENGTH, a value too long for it carried by reference (R8, cursor-ref.ts) on a table's
 * list, and refused on a derived list, which no row holds to read a reference back from (U37).
 */
import { CombError } from "../error.ts"
import { combErrorKeys } from "../types.ts"
import { CursorRef, MAX_CURSOR_LENGTH, mintCursor } from "./cursor.ts"
import type { CursorOptions } from "./cursor-seal.ts"
import type { SortField } from "./types.ts"

/** paginate's choice for an overflowing key: by reference on a table, refused on a derived list */
type KeysetKind = "derived" | "table"

const codePoints = (text: string): string[] => Array.from(text)

/** `record[field]` by reference: its longest prefix whose cursor fits, given the other values, cut on a code point; undefined when none does */
function longestFitting(record: Record<string, unknown>, field: string, fits: (r: Record<string, unknown>) => boolean) {
	const points = codePoints(record[field] as string)
	const ref = (n: number) => new CursorRef(points.slice(0, n).join(""), points.length)
	let [low, high] = [0, points.length]
	if (!fits({ ...record, [field]: ref(0) })) return undefined
	while (low < high) {
		const mid = Math.ceil((low + high) / 2)
		if (fits({ ...record, [field]: ref(mid) })) low = mid
		else high = mid - 1
	}
	return ref(low)
}

/** The overflow, as paginate reports it on the page that met it: a 500 naming the field and the cap */
function tooLong(fields: string, length: number, kind: KeysetKind | "unread"): CombError {
	const reasons = {
		derived: "a derived list reads no row to page by reference, so sort it by a key of bounded length",
		table: "even carried by reference, the other keys leave no room; sort by fewer long keys",
		unread:
			"its long key is an expression over more than its anchor's own columns, so no reference reads it back; sort by a key of bounded length, or an expression over the anchor table",
	}
	const reason = reasons[kind]
	return new CombError({
		cause: `a row's ${fields} is too long to page this list by: its cursor would be ${length} characters, past ${MAX_CURSOR_LENGTH}; ${reason}`,
		errorKey: combErrorKeys.SORT_NOT_WIRED,
		status: "internal_server_error",
	})
}

/**
 * Mint the cursor for the row after which the next page starts, as `paginate` does: its longest
 * string values carried by reference while it passes the cap that `readCursor` holds; a 500 on a
 * derived list (`keyset: "derived"`), or when no reference makes it fit
 */
function createCursor(
	row: Record<string, unknown>,
	sort: readonly SortField[],
	options: CursorOptions & {
		/* the sort fields whose keys read a reference back (readsBack); every one when not given */
		byReference?: ReadonlySet<string> | undefined
		idField?: string | undefined
		keyset?: KeysetKind | undefined
	},
): string {
	/* a date-mode ±infinity is bounded from its row, which a derived list has none of (3.24) */
	const unheld = sort.find(({ field }) => row[field] instanceof Date && Number.isNaN((row[field] as Date).getTime()))
	if (unheld !== undefined && options?.keyset === "derived") {
		throw new CombError({
			cause: `the sort by ${unheld.field} reads a date no JS Date holds (a Postgres 'infinity' read in date mode, or a SQLite timestamp holding ±Infinity), which a derived list has no row to read back; select it in string mode or sort by another column`,
			errorKey: combErrorKeys.SORT_NOT_WIRED,
			status: "internal_server_error",
		})
	}
	const mint = (record: Record<string, unknown>) => mintCursor(record, sort, options)
	const fits = (record: Record<string, unknown>) => mint(record).length <= MAX_CURSOR_LENGTH
	const whole = mint(row)
	if (whole.length <= MAX_CURSOR_LENGTH) return whole
	const fields = sort.map(({ field }) => field).join(", ")
	if (options.keyset === "derived") throw tooLong(fields, whole.length, "derived")
	const long = sort
		.map(({ field }) => field)
		.filter((field) => typeof row[field] === "string" && (options.byReference?.has(field) ?? true))
		.sort((a, b) => (row[b] as string).length - (row[a] as string).length)
	/* a long value no reference reads back is refused here, on the page that meets it, never minted to be refused (27.7) */
	const unread = sort.some(({ field }) => typeof row[field] === "string" && options.byReference?.has(field) === false)
	if (long.length === 0 && unread) throw tooLong(fields, whole.length, "unread")
	let record = row
	for (const field of long) {
		const ref = longestFitting(record, field, fits)
		record = { ...record, [field]: ref ?? new CursorRef("", codePoints(row[field] as string).length) }
		if (ref !== undefined) return mint(record)
	}
	throw tooLong(fields, whole.length, "table")
}

export { createCursor, type KeysetKind }
