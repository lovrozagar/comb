/**
 * A built list's pagination descriptor for a test that pages rows it made itself, with no builder:
 * the query and options a builder would have taken, a cursor able to resume it unless `cursorable`
 * says not, the window one past the page, as every builder reads, and no extras the rows must
 * carry unless `expects` names them.
 */
import type { KeysetKind } from "../cursor-mint.ts"
import type { CursorOptions } from "../cursor-seal.ts"
import { type ListExtra, type ListPagination, type PaginationFacts, paginationOf } from "../pagination.ts"

export function built(
	query: PaginationFacts["query"] & Record<string, unknown>,
	options: CursorOptions & { expects?: readonly ListExtra[] | undefined; keyset?: KeysetKind | undefined },
	cursorable = true,
): { pagination: ListPagination & { merged: false } } {
	const facts = { cursorable, expects: options.expects ?? [], keyset: options.keyset, query, window: query.limit + 1 }
	return { pagination: paginationOf(options, facts) }
}
