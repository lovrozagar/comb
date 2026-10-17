import { describe, expect, it } from "vitest"
import { COMB_META_KEY } from "../meta.ts"
import { buildDefaultOrder, listQueryStamp, selectableFrom } from "./list-meta.ts"
import { LIST_QUERY_LIMITS } from "./schema-limits.ts"

describe("buildDefaultOrder", () => {
	it("is the first sort field descending, or empty when there is none", () => {
		expect(buildDefaultOrder(["created_at", "title"])).toBe("created_at.desc")
		expect(buildDefaultOrder([])).toBe("")
	})
})

describe("selectableFrom", () => {
	it("publishes the scalars only, and nothing without a fields config", () => {
		expect(selectableFrom({ relations: ["author"], scalars: ["id", "title"] })).toEqual(["id", "title"])
		expect(selectableFrom(undefined)).toEqual([])
	})
})

describe("listQueryStamp", () => {
	it("publishes the config's facts and the limits it enforces", () => {
		const stamp = listQueryStamp(
			{ filter: { title: "string" }, pagination: { maxLimit: 50 }, search: ["title"], sort: ["created_at"] },
			LIST_QUERY_LIMITS,
		)[COMB_META_KEY]
		expect(stamp).toMatchObject({
			defaultOrder: "created_at.desc",
			filterable: ["title"],
			kind: "query",
			maxFilterValues: 60,
			maxLimit: 50,
			maxSearchTerms: 8,
			searchable: ["title"],
			selectable: [],
			sortable: ["created_at"],
			stableTiebreak: "id",
		})
	})

	it("publishes no filter or search, and the default max limit, when the config declares none", () => {
		expect(listQueryStamp({ sort: [] }, LIST_QUERY_LIMITS)[COMB_META_KEY]).toMatchObject({
			defaultOrder: "",
			filterFields: [],
			filterable: [],
			maxLimit: 100,
			searchable: [],
		})
	})
})
