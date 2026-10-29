import { sql } from "drizzle-orm"
import { describe, expect, it } from "vitest"
import { built } from "../__fixtures__/built.ts"
import { SEALED } from "../__fixtures__/cursor-secret.ts"
import { applyListQuery } from "./apply-list-query.ts"
import type { ListQueryResult } from "./build-list-query.ts"

/** A builder that records each call, returning itself as drizzle's dynamic select does */
function recorder() {
	const calls: string[] = []
	const builder = {
		calls,
		limit: (n: number) => (calls.push(`limit ${n}`), builder),
		offset: (n: number) => (calls.push(`offset ${n}`), builder),
		orderBy: (...order: unknown[]) => (calls.push(`orderBy ${order.length}`), builder),
		where: () => (calls.push("where"), builder),
	}
	return builder
}

const query = (where: ListQueryResult["where"]): ListQueryResult => ({
	limit: 3,
	meta: { limit: 2, page: 1, type: "offset" },
	offset: 0,
	orderBy: [sql`1`, sql`2`],
	pagination: built({ limit: 2, parsedSort: [] }, SEALED).pagination,
	search: null,
	where,
})

/* C12 of the 0.14.1 review */
describe("applyListQuery", () => {
	it("applies the WHERE, ORDER BY, LIMIT and OFFSET to a builder, the WHERE only when the list has one", () => {
		const builder = recorder()
		applyListQuery(builder, query(sql`x = 1`))
		expect(builder.calls).toEqual(["where", "orderBy 2", "limit 3", "offset 0"])
		const bare = recorder()
		applyListQuery(bare, query(undefined))
		expect(bare.calls).toEqual(["orderBy 2", "limit 3", "offset 0"])
	})

	it("makes a builder dynamic first when it can be", () => {
		const builder = recorder()
		const select = { $dynamic: () => (builder.calls.push("$dynamic"), builder) }
		expect(applyListQuery(select, query(undefined))).toBe(builder)
		expect(builder.calls).toEqual(["$dynamic", "orderBy 2", "limit 3", "offset 0"])
	})
})
