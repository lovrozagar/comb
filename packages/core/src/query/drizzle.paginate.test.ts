/** queryHelpers.paginate beyond the id-keyed rows drizzle.test.ts pages */
import { describe, expect, it } from "vitest"
import { createCursor, verifiedCursor } from "./cursor.ts"
import { queryHelpers } from "./drizzle.ts"
import { createListQuerySchema } from "./schema.ts"
import { CURSOR_SECRET, SIGNED } from "./__fixtures__/cursor-secret.ts"

describe("queryHelpers.paginate on rows keyed by another field (C8)", () => {
	it("mints the next cursor from idField, as createCursor and buildDerivedListQuery take it", () => {
		const schema = createListQuerySchema({ sort: ["_created_at"] })
		const query = schema.parse({ limit: "2", order: "_created_at.desc" })
		const rows = [
			{ _created_at: 3, _id: "r3" },
			{ _created_at: 2, _id: "r2" },
			{ _created_at: 1, _id: "r1" },
		]
		const [items, meta] = queryHelpers.paginate(rows, query, { ...SIGNED, idField: "_id" })
		expect(items.map((row) => row["_id"])).toEqual(["r3", "r2"])
		expect(verifiedCursor(meta.nextCursor as string, CURSOR_SECRET)).toMatchObject({ id: "r2", values: [2] })
		expect(() => queryHelpers.paginate(rows, query, SIGNED)).toThrow(
			expect.objectContaining({ errorKey: "sort_not_wired" }),
		)
	})
})

describe("the cursor helpers called without their options, as JS or a cast can", () => {
	const schema = createListQuerySchema({ sort: ["name"] })
	const notWired = expect.objectContaining({ errorKey: "cursor_not_wired", status: 500 })
	const missing = undefined as unknown as typeof SIGNED

	it("say the secret is missing, rather than fail to destructure", () => {
		const query = schema.parse({ limit: "1" })
		expect(() => queryHelpers.listOptions(query, missing)).toThrow(notWired)
		expect(() => queryHelpers.paginate([{ id: "a", name: "x" }], query, missing)).toThrow(notWired)
		expect(() => createCursor({ id: "a", name: "x" }, query.parsedSort, missing)).toThrow(notWired)
	})
})
