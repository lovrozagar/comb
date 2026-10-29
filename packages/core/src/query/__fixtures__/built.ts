/**
 * A built list's pagination descriptor for a test that pages rows it made itself, with no builder:
 * the query and options a builder would have taken, a cursor able to resume it unless `cursorable`
 * says not, and the window one past the page, as every builder reads.
 */
import type { KeysetKind } from "../cursor-mint.ts"
import type { CursorOptions } from "../cursor-seal.ts"
import { type PaginationFacts, paginationOf } from "../pagination.ts"

export function built(
	query: PaginationFacts["query"] & Record<string, unknown>,
	options: CursorOptions & { idField?: string | undefined; keyset?: KeysetKind | undefined },
	cursorable = true,
): { pagination: ReturnType<typeof paginationOf> } {
	const facts = { cursorable, idField: options.idField, keyset: options.keyset, query, window: query.limit + 1 }
	return { pagination: paginationOf(options, facts) }
}
