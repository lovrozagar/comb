import { describe, expect, it } from "vitest"
import type { SharedSchema, TableInfo } from "./dto-types.ts"
import {
	collectUsedTimestampCombos,
	comboFields,
	comboOf,
	generateSharedFile,
	type TimestampCombo,
	timestampNames,
} from "./timestamps.ts"

function table(has: TableInfo["hasTimestamps"], style: TableInfo["timestampStyle"] = "camelCase"): TableInfo {
	return { combMeta: null, fields: [], hasTimestamps: has, name: "t", needsSharedMeta: false, timestampStyle: style }
}

const ALL = { createdAt: true, deletedAt: true, updatedAt: true }

describe("timestamp combos", () => {
	it("name the spread a table's timestamps use", () => {
		expect(
			comboOf({ hasTimestamps: { createdAt: false, deletedAt: true, updatedAt: true }, timestampStyle: "camelCase" }),
		).toBeNull()
		expect(
			comboOf({ hasTimestamps: { createdAt: true, deletedAt: false, updatedAt: false }, timestampStyle: "camelCase" }),
		).toBe("Created")
		expect(
			comboOf({ hasTimestamps: { createdAt: true, deletedAt: true, updatedAt: false }, timestampStyle: "camelCase" }),
		).toBe("Created")
		expect(
			comboOf({ hasTimestamps: { createdAt: true, deletedAt: false, updatedAt: true }, timestampStyle: "camelCase" }),
		).toBe("CreatedUpdated")
		expect(comboOf({ hasTimestamps: ALL, timestampStyle: "camelCase" })).toBe("CreatedUpdatedDeleted")
		expect(comboOf({ hasTimestamps: ALL, timestampStyle: "mixed" })).toBeNull()
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
	const none = { camelCase: new Set<TimestampCombo>(), snakeCase: new Set<TimestampCombo>() }

	it("emits what a DTO imports and what that names, nothing else (F17)", () => {
		const file = generateSharedFile(none, new Map(), new Set(["timestampSchema"]))
		expect(file).toContain("export const timestampSchema = _intNN.max(Number.MAX_SAFE_INTEGER).meta(_m.timestamp)")
		expect(file).toContain("export const _intNN = ")
		expect(file).toContain("export const _m = {")
		expect(file).not.toContain("export const _str")
		expect(file).not.toContain("timestampNullableSchema")
		expect(file).not.toContain("Auto-deduped")
		expect(file).toContain('import * as z from "zod"')
	})

	it("imports zod only when what it keeps uses it, and is an empty module when it keeps nothing (F12)", () => {
		expect(generateSharedFile(none, new Map(), new Set()).trim()).toBe("export {}")
		const meta = generateSharedFile(none, new Map(), new Set(["_m"]))
		expect(meta).toContain("export const _m = {")
		expect(meta).not.toContain("zod")
	})

	it("emits the shared constants with their use counts before the spreads that name them", () => {
		const shared = new Map<string, SharedSchema>([
			["z.string().max(9)", { code: "_str.max(9)", count: 3, name: "_z0" }],
			["timestampSchema.nullable()", { code: "timestampSchema.nullable()", count: 0, name: "_z1" }],
		])
		const file = generateSharedFile(
			{ camelCase: new Set(["CreatedUpdatedDeleted"]), snakeCase: new Set(["Created"]) },
			shared,
			new Set(["_z0", "timestampsCreatedUpdatedDeletedRead", "timestampsCreatedCreateSnakeCase"]),
		)
		expect(file).toContain("export const _z0 = _str.max(9) /* 3x */")
		expect(file).toContain("export const _z1 = timestampSchema.nullable()\n")
		expect(file).toContain(
			"export const timestampsCreatedUpdatedDeletedRead = {\n\tcreatedAt: timestampSchema,\n\tdeletedAt: _z1,",
		)
		expect(file).toContain(
			"export const timestampsCreatedCreateSnakeCase = {\n\tcreated_at: timestampSchema.optional(),\n}",
		)
		expect(file).not.toContain("timestampsCreatedUpdatedDeletedCreate =")
		expect(file).not.toMatch(/validateTimestamps|Refinements/)
		expect(file.indexOf("_z0 =")).toBeLessThan(file.indexOf("timestampsCreatedUpdatedDeletedRead"))
	})
})
