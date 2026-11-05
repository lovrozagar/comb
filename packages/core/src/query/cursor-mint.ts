/**
 * Minting a cursor that `readCursor` will open: one whose sealed length stays within
 * MAX_CURSOR_LENGTH, a value too long for it carried by reference (R8, cursor-ref.ts) on a table's
 * list, and refused on a derived list, which no row holds to read a reference back from (U37).
 */
import { CombError } from "../error.ts"
import { combErrorKeys } from "../types.ts"
import { cursorBytes, CursorRef, MAX_CURSOR_LENGTH } from "./cursor.ts"
import { readsApart } from "./cursor-reads.ts"
import { type CursorOptions, seal, sealedLength } from "./cursor-seal.ts"
import { roundedKey } from "./rounded-key.ts"
import type { SortField } from "./types.ts"

/**
 * The open's column check a builder hands the mint: the index of the first value, the tiebreak id last,
 * its column does not hold, `carried` saying which the cursor flags as stored text; -1 when all fit
 */
type ColumnCheck = (values: readonly unknown[], carried: (index: number) => boolean) => number

/** paginate's choice for an overflowing key: by reference on a table, refused on a derived or a merged list */
type KeysetKind = "derived" | "merged" | "table"

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
		merged:
			"a merged list's row is on one shard only, so no reference reads its value back on the others; sort it by a key of bounded length",
		table: "even carried by reference, the other keys leave no room; sort by fewer long keys",
		unread:
			"its long key is a column not of the anchor table, or an expression over one, so no reference reads its value back; sort by a key of bounded length, or by a column of the anchor table",
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
 * derived list (`keyset: "derived"`), or when no reference makes it fit; a 500 on a derived list's
 * integer key past ±(2^53 − 1), which it binds as the driver rounded it
 */
function createCursor(
	row: Record<string, unknown>,
	sort: readonly SortField[],
	options: CursorOptions & {
		// QL1 of r22b
		/** the sort fields the list binds as the row read them, with no row to read a bound from; every one on a derived list */
		asRead?: ReadonlySet<string> | undefined
		/** the sort fields a long value of may go by reference to its row; every one when not given */
		byReference?: ReadonlySet<string> | undefined
		// AB2 ruling
		/** the sort fields whose value in `row` is the key's stored text, which the next page binds as itself */
		carried?: ReadonlySet<string> | undefined
		/** the field of `row` that holds the tiebreak id; default `id` */
		idField?: string | undefined
		/** how a value too long for the cap is carried: by reference on "table", the default; refused with a 500 on "derived" or "merged" */
		keyset?: KeysetKind | undefined
	},
): string {
	return fitCursor(row, sort, options)
}

// B2-6 and AB3-3 of area B: paginate mints through here so readCursor returns the value its row read
/**
 * createCursor for the row paginate typed, bound by its stored values: `read` is the row as the driver
 * read it, whose value readCursor returns for a key bound otherwise
 */
function fitCursor(
	row: Record<string, unknown>,
	sort: readonly SortField[],
	options: Parameters<typeof createCursor>[2] & { read?: Record<string, unknown> | undefined },
): string {
	return fittedCursor(row, sort, options)()
}

// AB4-3 of area B: paginate runs it on every row it serves, so a row no cursor holds is refused wherever it lands
/**
 * fitCursor's every refusal of `row`, run with no seal, and what seals its cursor: the cap is measured
 * on the plaintext (sealedLength), so a page checks each row it serves and seals the last alone
 */
function fittedCursor(
	row: Record<string, unknown>,
	sort: readonly SortField[],
	options: Parameters<typeof fitCursor>[2] & {
		// AB4-1 of area B
		/** the open's column check, run on the record sealed; none on a row no builder read */
		holds?: ColumnCheck | undefined
	},
): () => string {
	/* a key bound as read has no row to read a bound from: a derived list's every key, an anchored list's joined one (QL1 of r22b) */
	const derived = options?.keyset === "derived"
	const asRead = (field: string) => derived || (options?.asRead?.has(field) ?? false)
	refuseInvalidDate(row, sort, { asRead, derived })
	/* a key bound as the driver read it skips rows or repeats one once rounded (Q1 of r19, QL1 of r22b) */
	const rounded = roundedKey(row, sort, derived ? "derived" : { unread: asRead })
	if (rounded !== undefined) throw rounded
	/* options a JS caller left out are refused by seal, by name */
	const settled = options && {
		...options,
		read: readsApart(
			options.read,
			row,
			sort.map(({ field }) => field),
		),
	}
	const bytes = (record: Record<string, unknown>) => cursorBytes(record, sort, settled)
	/* the record sealed is held to the check the next page opens it by, so it never refuses what this page minted */
	const sealer = (plaintext: Uint8Array, record: Record<string, unknown>) => {
		refuseUnfit(record, sort, options)
		return () => seal(plaintext, options)
	}
	const fits = (record: Record<string, unknown>) => sealedLength(bytes(record).length) <= MAX_CURSOR_LENGTH
	const whole = bytes(row)
	const length = sealedLength(whole.length)
	if (length <= MAX_CURSOR_LENGTH) return sealer(whole, row)
	const fields = sort.map(({ field }) => field).join(", ")
	if (options.keyset === "derived" || options.keyset === "merged") throw tooLong(fields, length, options.keyset)
	const long = sort
		.map(({ field }) => field)
		.filter((field) => typeof row[field] === "string" && (options.byReference?.has(field) ?? true))
		.sort((a, b) => (row[b] as string).length - (row[a] as string).length)
	/* a long value no reference reads back is refused here, on the page that meets it, never minted to be refused (27.7) */
	const unread = sort.some(({ field }) => typeof row[field] === "string" && options.byReference?.has(field) === false)
	if (long.length === 0 && unread) throw tooLong(fields, length, "unread")
	let record = row
	for (const field of long) {
		const ref = longestFitting(record, field, fits)
		record = { ...record, [field]: ref ?? new CursorRef("", codePoints(row[field] as string).length) }
		if (ref !== undefined) return sealer(bytes(record), record)
	}
	throw tooLong(fields, length, "table")
}

/** A 500 naming a key bound as read (`at.asRead`) whose row read an Invalid Date, which no cursor binds; a date-mode ±infinity is bounded from its row (3.24) */
function refuseInvalidDate(
	row: Record<string, unknown>,
	sort: readonly SortField[],
	at: { asRead: (field: string) => boolean; derived: boolean },
): void {
	const unheld = sort.find(
		({ field }) => at.asRead(field) && row[field] instanceof Date && Number.isNaN((row[field] as Date).getTime()),
	)
	if (unheld === undefined) return
	throw new CombError({
		cause: `the sort by ${unheld.field} reads a date no JS Date holds (a Postgres 'infinity' read in date mode, or a SQLite timestamp holding ±Infinity), which this list has no row to read back by, ${at.derived ? "a derived list having none" : "its key being no column of the anchor table"}; select it in string mode or sort by another column`,
		errorKey: combErrorKeys.SORT_NOT_WIRED,
		status: "internal_server_error",
	})
}

/** A 500 naming the first value of `record` its column does not hold (ColumnCheck), the cursor the next page would refuse */
function refuseUnfit(
	record: Record<string, unknown>,
	sort: readonly SortField[],
	options: Parameters<typeof fittedCursor>[2],
): void {
	/* a row no builder read has no check, and options a JS caller left out are refused by seal, by name */
	if (options?.holds === undefined) return
	const idField = options.idField ?? "id"
	const values = [...sort.map(({ field }) => record[field]), record[idField]]
	const index = options.holds(values, (i) => options.carried?.has(sort[i]?.field ?? "") ?? false)
	if (index === -1) return
	const named = sort[index] === undefined ? `the tiebreak id ${idField}` : `the sort by ${sort[index].field}`
	throw new CombError({
		cause: `${named} reads a value its column's mode does not hold (a JSON-mode key's, or a SQLite column's of another storage class than its mode reads), which no cursor of this list resumes after; sort by another column`,
		errorKey: combErrorKeys.SORT_NOT_WIRED,
		status: "internal_server_error",
	})
}

export { type ColumnCheck, createCursor, fitCursor, fittedCursor, type KeysetKind }
