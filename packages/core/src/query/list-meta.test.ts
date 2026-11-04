import { describe, expect, it } from "vitest"
import { COMB_META_KEY } from "../meta.ts"
import { buildDefaultOrder, listQueryStamp, selectableFrom } from "./list-meta.ts"
import { createListQuerySchema } from "./list-schema.ts"
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

/* U11 of the 0.12 round: the byte caps the schema enforces are published where a client reads its limits */
describe("listQueryStamp: the request byte caps", () => {
	it("stamps the filter's and the search's encoded byte caps", () => {
		const stamp = listQueryStamp({ search: ["title"], sort: ["id"] }, LIST_QUERY_LIMITS)
		expect(stamp[COMB_META_KEY]).toMatchObject({ maxFilterBytes: 4608, maxQueryBytes: 14_336, maxSearchBytes: 600 })
	})
})

/* QL10 of r22b: the stamp published "id" whatever column the list breaks ties on, such as a derived list's `_id` */
/** The stableTiebreak a list schema built with `config` publishes */
function tiebreakOf(config: { tiebreak?: string | undefined }): unknown {
	const meta: Record<string, unknown> = createListQuerySchema({ ...config, sort: ["created_at"] }).meta() ?? {}
	return (meta[COMB_META_KEY] as { stableTiebreak?: unknown } | undefined)?.stableTiebreak
}

describe("the published stableTiebreak is the list's own (QL10 of r22b; sibling: the default)", () => {
	it("publishes the tiebreak the config names, and id without one", () => {
		expect(tiebreakOf({ tiebreak: "_id" })).toBe("_id")
		expect(tiebreakOf({})).toBe("id")
		expect(tiebreakOf({ tiebreak: undefined })).toBe("id")
	})

	it("refuses an empty tiebreak at build, which names no column", () => {
		expect(() => tiebreakOf({ tiebreak: "" })).toThrow(
			new TypeError('createListQuerySchema: tiebreak must name the column the list breaks ties on; got ""'),
		)
	})
})
