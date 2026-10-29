/** queryHelpers.paginate beyond the id-keyed rows drizzle.test.ts pages */
import { describe, expect, it } from "vitest"
import { openCursor } from "./cursor.ts"
import { createCursor } from "./cursor-mint.ts"
import { queryHelpers } from "./drizzle.ts"
import { createListQuerySchema } from "./schema.ts"
import { SEALED } from "./__fixtures__/cursor-secret.ts"
import { built } from "./__fixtures__/built.ts"

describe("queryHelpers.paginate mints the next cursor's id from _combId (Q2 of r17)", () => {
	it("reads the tiebreak the builder selected, never the row's own id, and strips it", () => {
		const schema = createListQuerySchema({ sort: ["_created_at"] })
		const query = schema.parse({ limit: "2", order: "_created_at.desc" })
		const rows = [
			{ _combId: "t3", _created_at: 3, id: "r3" },
			{ _combId: "t2", _created_at: 2, id: "r2" },
			{ _combId: "t1", _created_at: 1, id: "r1" },
		]
		const [items, meta] = queryHelpers.paginate(rows, built(query, SEALED))
		expect(items).toEqual([
			{ _created_at: 3, id: "r3" },
			{ _created_at: 2, id: "r2" },
		])
		expect(openCursor(meta.nextCursor as string, SEALED)).toMatchObject({ id: "t2", values: [2] })
		const unwired = rows.map(({ _combId, ...row }) => row)
		expect(() => queryHelpers.paginate(unwired, built(query, SEALED))).toThrow(
			expect.objectContaining({ errorKey: "sort_not_wired" }),
		)
	})
})

describe("the cursor helpers called without their options, as JS or a cast can", () => {
	const schema = createListQuerySchema({ sort: ["name"] })
	const notWired = expect.objectContaining({ errorKey: "cursor_not_wired", status: 500 })
	const missing = undefined as unknown as typeof SEALED

	it("say the secret is missing, rather than fail to destructure", () => {
		const query = schema.parse({ limit: "1" })
		expect(() => queryHelpers.listOptions(query, missing)).toThrow(notWired)
		expect(() => createCursor({ id: "a", name: "x" }, query.parsedSort, missing)).toThrow(notWired)
	})

	/* plan 15's 12.2: paginate takes the built query, which holds the options; the call before 0.15 says so */
	it("names the built query paginate takes, given the parsed query and options it took before 0.15", () => {
		const query = schema.parse({ limit: "1" })
		const before = queryHelpers.paginate as unknown as (rows: object[], q: object, o?: object) => unknown
		for (const call of [() => before([], query, SEALED), () => before([], undefined as never)])
			expect(call).toThrow(
				expect.objectContaining({
					cause: expect.stringMatching(/^paginate takes the built query/),
					errorKey: "page_not_wired",
				}),
			)
	})
})
