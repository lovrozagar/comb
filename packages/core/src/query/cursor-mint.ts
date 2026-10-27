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
function tooLong(fields: string, length: number, kind: KeysetKind): CombError {
	const reason =
		kind === "derived"
			? "a derived list reads no row to page by reference, so sort it by a key of bounded length"
			: "even carried by reference, the other keys leave no room; sort by fewer long keys"
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
	options: CursorOptions & { idField?: string | undefined; keyset?: KeysetKind | undefined },
): string {
	const mint = (record: Record<string, unknown>) => mintCursor(record, sort, options)
	const fits = (record: Record<string, unknown>) => mint(record).length <= MAX_CURSOR_LENGTH
	const whole = mint(row)
	if (whole.length <= MAX_CURSOR_LENGTH) return whole
	const fields = sort.map(({ field }) => field).join(", ")
	if (options.keyset === "derived") throw tooLong(fields, whole.length, "derived")
	const long = sort
		.map(({ field }) => field)
		.filter((field) => typeof row[field] === "string")
		.sort((a, b) => (row[b] as string).length - (row[a] as string).length)
	let record = row
	for (const field of long) {
		const ref = longestFitting(record, field, fits)
		record = { ...record, [field]: ref ?? new CursorRef("", codePoints(row[field] as string).length) }
		if (ref !== undefined) return mint(record)
	}
	throw tooLong(fields, whole.length, "table")
}

export { createCursor, type KeysetKind }
