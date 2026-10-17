import { describe, expect, it } from "vitest"
import type { SharedSchema, TableInfo } from "./dto-types.ts"
import { collectUsedTimestampCombos, comboFields, comboOf, generateSharedFile, timestampNames } from "./timestamps.ts"

function table(has: TableInfo["hasTimestamps"], style: TableInfo["timestampStyle"] = "camelCase"): TableInfo {
	return { combMeta: null, fields: [], hasTimestamps: has, name: "t", needsSharedMeta: false, timestampStyle: style }
}

const ALL = { createdAt: true, deletedAt: true, updatedAt: true }

describe("timestamp combos", () => {
	it("name the spread a table's timestamps use", () => {
		expect(comboOf({ createdAt: false, deletedAt: true, updatedAt: true })).toBeNull()
		expect(comboOf({ createdAt: true, deletedAt: false, updatedAt: false })).toBe("Created")
		expect(comboOf({ createdAt: true, deletedAt: true, updatedAt: false })).toBe("Created")
		expect(comboOf({ createdAt: true, deletedAt: false, updatedAt: true })).toBe("CreatedUpdated")
		expect(comboOf(ALL)).toBe("CreatedUpdatedDeleted")
	})

	it("list each combo's columns under the table's casing", () => {
		const snake = timestampNames("snake_case")
		expect(comboFields("Created", snake)).toEqual([{ name: "created_at", nullable: false }])
		expect(comboFields("CreatedUpdatedDeleted", timestampNames("camelCase"))).toEqual([
			{ name: "createdAt", nullable: false },
			{ name: "deletedAt", nullable: true },
			{ name: "updatedAt", nullable: false },
		])
	})

	it("collect the combos in use per casing", () => {
		const used = collectUsedTimestampCombos([
			table(ALL),
			table({ ...ALL, deletedAt: false }, "snake_case"),
			table({ ...ALL, createdAt: false }),
		])
		expect([...used.camelCase]).toEqual(["CreatedUpdatedDeleted"])
		expect([...used.snakeCase]).toEqual(["CreatedUpdated"])
	})
})

describe("generateSharedFile", () => {
	it("emits the base aliases, examples and timestamp schemas, and nothing per style when unused", () => {
		const file = generateSharedFile({ camelCase: new Set(), snakeCase: new Set() }, new Map())
		expect(file).toContain("export const _str = z.string()")
		expect(file).toContain("export const timestampSchema = _intNN.max(Number.MAX_SAFE_INTEGER).meta(_m.timestamp)")
		expect(file).not.toContain("Auto-deduped")
		expect(file).not.toContain("timestampsCreated")
	})

	it("emits the shared constants with their use counts before the spreads", () => {
		const shared = new Map<string, SharedSchema>([
			["z.string().max(9)", { code: "_str.max(9)", count: 3, name: "_z0" }],
			["timestampSchema.nullable()", { code: "timestampSchema.nullable()", count: 0, name: "_z1" }],
		])
		const file = generateSharedFile(
			{ camelCase: new Set(["CreatedUpdatedDeleted"]), snakeCase: new Set(["Created"]) },
			shared,
		)
		expect(file).toContain("export const _z0 = _str.max(9) /* 3x */")
		expect(file).toContain("export const _z1 = timestampSchema.nullable()\n")
		expect(file).toContain(
			"export const timestampsCreatedUpdatedDeletedRead = {\n\tcreatedAt: timestampSchema,\n\tdeletedAt: _z1,",
		)
		expect(file).toContain("export const validateTimestampsDeletedAfterCreated = (data: any)")
		expect(file).toContain(
			'export const timestampsOptionalRefinements = {\n\tdeletedAfterCreated: {\n\t\tmessage: "deletedAt cannot be before createdAt",',
		)
		expect(file).toContain(
			"export const timestampsCreatedCreateSnakeCase = {\n\tcreated_at: timestampSchema.optional(),\n}",
		)
		expect(file).not.toContain("validateTimestampsUpdatedAfterCreatedSnakeCase")
		expect(file.indexOf("_z0 =")).toBeLessThan(file.indexOf("timestampsCreatedUpdatedDeletedRead"))
	})

	it("emits the updated-only refinements for a CreatedUpdated combo", () => {
		const file = generateSharedFile({ camelCase: new Set(["CreatedUpdated"]), snakeCase: new Set() }, new Map())
		expect(file).toContain("validateTimestampsUpdatedAfterCreated")
		expect(file).not.toContain("deletedAfterCreated")
	})
})
