/**
 * The steps of the list query schema's transform: the filter AST, the sort, and the output
 * check. Each reports what it refuses as an issue on the param it read.
 */
import type * as z from "zod"

import { cursorProblem } from "./cursor.ts"
import { type FilterLimits, parseOrder, validateFilter } from "./filter.ts"
import type { FieldType, FilterAST, SortDirection, SortField } from "./types.ts"

type FilterParam = { fields: Record<string, FieldType>; limits: FilterLimits }

/** The validated filter's AST, or null when there is none or it is refused */
function filterAstOf(
	filter: string | undefined,
	{ fields, limits }: FilterParam,
	ctx: z.RefinementCtx,
): FilterAST | null {
	if (!filter) return null
	const result = validateFilter(filter, fields, limits)
	if (result?.valid) return result.ast
	if (result) ctx.addIssue({ code: "custom", message: result.errors.join("; "), path: ["filter"] })
	return null
}

type SortParam<TSortField extends string> = { maxSortKeys: number; sort: readonly TSortField[] }

/** The requested order over declared fields; the first declared field descending when none is named */
function parsedSortOf<TSortField extends string>(
	order: string | undefined,
	{ maxSortKeys, sort }: SortParam<TSortField>,
	ctx: z.RefinementCtx,
): Array<SortField<TSortField>> {
	const rawSort = parseOrder(order)
	if (rawSort.length > maxSortKeys) {
		ctx.addIssue({
			code: "custom",
			message: `Too many sort keys: ${rawSort.length} (max ${maxSortKeys})`,
			path: ["order"],
		})
	}
	const declared = new Set<string>(sort)
	const parsedSort: Array<SortField<TSortField>> = []
	for (const { direction, field, nulls } of rawSort) {
		if (!declared.has(field)) {
			ctx.addIssue({ code: "custom", message: `Unknown sort field: ${field}`, path: ["order"] })
			continue
		}
		const entry: SortField<TSortField> = { direction, field: field as TSortField }
		if (nulls) entry.nulls = nulls
		parsedSort.push(entry)
	}
	const fallback = sort[0]
	if (parsedSort.length === 0 && fallback !== undefined) parsedSort.push({ direction: "desc", field: fallback })
	return parsedSort
}

/** An issue on `cursor` when it has no sealed cursor's shape; what it holds, readCursor opens */
function checkCursor(cursor: string | undefined, ctx: z.RefinementCtx): void {
	const problem = cursor ? cursorProblem(cursor) : null
	if (problem) ctx.addIssue({ code: "custom", message: problem, path: ["cursor"] })
}

/** Each sort field's direction */
function sortOrderByOf<TSortField extends string>(
	parsedSort: ReadonlyArray<SortField<TSortField>>,
): Partial<Record<TSortField, SortDirection>> {
	return Object.fromEntries(parsedSort.map(({ direction, field }) => [field, direction])) as Partial<
		Record<TSortField, SortDirection>
	>
}

/** Every issue `outputSchema` finds in `output`, reported at its own path */
function reportOutputIssues(outputSchema: z.ZodType, output: unknown, ctx: z.RefinementCtx): void {
	const result = outputSchema.safeParse(output)
	for (const issue of result.error?.issues ?? []) {
		ctx.addIssue({ code: "custom", message: issue.message, path: issue.path })
	}
}

export { checkCursor, filterAstOf, parsedSortOf, reportOutputIssues, sortOrderByOf }
