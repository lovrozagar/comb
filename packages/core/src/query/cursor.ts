/**
 * Cursor-based pagination — encode/decode + pagination helpers.
 * DB-agnostic: no SQL dependencies.
 */
import type { SortDirection, SortField } from "./types.ts"

/**
 * Column keyset pagination breaks ties on.
 *
 * This is the single source of truth for the tiebreak: the SQL builders resolve
 * the column by this name, and `createListQuerySchema` publishes it as
 * `stableTiebreak`. Keeping one constant is what stops the published fact from
 * drifting away from the query that is actually run.
 *
 * A table whose primary-key property is named something else has no cursor
 * predicate applied at all — rows then duplicate and skip across pages — so
 * `validateTables()` rejects that shape rather than letting it fail silently.
 */
const CURSOR_TIEBREAK_COLUMN = "id"

type CursorPayload = {
	c: unknown
	d?: "asc" | "desc" | undefined
	i: string
}

type CursorInfo = {
	direction: SortDirection
	idValue: string
	sortValue: unknown
}

type PaginationQueryInput = {
	cursor?: string
	limit: number
	page?: number
	parsedSort: SortField[]
}

type PaginationOptions = {
	limit: number
	offset: number
}

type PaginationMeta = {
	count: number
	hasMore: boolean
	limit: number
	nextCursor: string | null
	page: number | null
}

function encodeCursor(payload: CursorPayload): string {
	const json = JSON.stringify(payload)
	if (typeof btoa === "function") {
		return btoa(json)
	}
	return Buffer.from(json).toString("base64")
}

function decodeCursor(cursor: string | null | undefined): CursorPayload | null {
	if (!cursor) {
		return null
	}

	try {
		let json: string
		if (typeof atob === "function") {
			json = atob(cursor)
		} else {
			json = Buffer.from(cursor, "base64").toString("utf8")
		}

		const parsed = JSON.parse(json) as unknown

		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"i" in parsed &&
			typeof (parsed as CursorPayload).i === "string"
		) {
			return parsed as CursorPayload
		}

		return null
	} catch {
		return null
	}
}

function createCursor<T>(
	record: T,
	sortField: string,
	opts?: { direction?: "asc" | "desc"; idField?: string },
): string {
	const rec = record as Record<string, unknown>
	const idField = opts?.idField ?? "id"
	return encodeCursor({
		c: rec[sortField],
		d: opts?.direction,
		i: rec[idField] as string,
	})
}

function parseCursorForQuery(cursor: string | null | undefined, sortDirection: SortDirection): CursorInfo | null {
	const decoded = decodeCursor(cursor)
	if (!decoded) {
		return null
	}

	/* Stale cursor — encoded direction differs from current query direction */
	if (decoded.d !== undefined && decoded.d !== sortDirection) {
		return null
	}

	return {
		direction: sortDirection,
		idValue: decoded.i,
		sortValue: decoded.c,
	}
}

/** Get primary sort direction from parsed sort array, defaults to "desc" */
function getPrimarySortDirection(parsedSort: SortField[]): SortDirection {
	return parsedSort[0]?.direction ?? "desc"
}

export {
	createCursor,
	CURSOR_TIEBREAK_COLUMN,
	decodeCursor,
	encodeCursor,
	getPrimarySortDirection,
	parseCursorForQuery,
	type CursorInfo,
	type CursorPayload,
	type PaginationMeta,
	type PaginationOptions,
	type PaginationQueryInput,
}
