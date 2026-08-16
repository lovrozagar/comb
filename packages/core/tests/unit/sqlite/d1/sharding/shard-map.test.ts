import { getTableColumns, getTableName } from "drizzle-orm"
import { describe, expect, it } from "vitest"
import { shardMap } from "../../../../../src/sqlite/d1/sharding/shard-map.ts"

describe("shardMap table definition", () => {
	it("has correct table name", () => {
		expect(getTableName(shardMap)).toBe("shard_map")
	})

	it("has all expected columns", () => {
		const cols = getTableColumns(shardMap)
		const columnNames = Object.keys(cols)
		expect(columnNames).toContain("org_id")
		expect(columnNames).toContain("shard_id")
		expect(columnNames).toContain("driver")
		expect(columnNames).toContain("target")
		expect(columnNames).toContain("created_at")
		expect(columnNames).toContain("updated_at")
		expect(columnNames).toContain("deleted_at")
	})

	it("org_id is primary key", () => {
		const cols = getTableColumns(shardMap)
		expect(cols.org_id).toHaveProperty("primary", true)
	})

	it("shard_id is not null", () => {
		const cols = getTableColumns(shardMap)
		expect(cols.shard_id).toHaveProperty("notNull", true)
	})

	it("target is not null", () => {
		const cols = getTableColumns(shardMap)
		expect(cols.target).toHaveProperty("notNull", true)
	})

	it("driver defaults to d1", () => {
		const cols = getTableColumns(shardMap)
		expect(cols.driver).toHaveProperty("hasDefault", true)
	})
})
