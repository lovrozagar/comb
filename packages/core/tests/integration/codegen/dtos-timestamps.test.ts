/**
 * The 0.12 codegen review's F10: a read DTO takes a timestamp from the shared spread only when the
 * column's own read schema is the spread's, so a private or a nullable timestamp keeps its own rule
 */
import * as z from "zod"
import { afterAll, describe, expect, it } from "vitest"
import { readCombEntityMeta } from "../../../src/meta.ts"
import { cleanGeneratedDtos, generatedDtos } from "../support/dtos.ts"

afterAll(() => cleanGeneratedDtos())

describe("timestamps the shared spread would get wrong (F10)", () => {
	it("never reads back or publishes a private deletedAt", async () => {
		const dtos = await generatedDtos(
			"f10-private",
			`export const doc = sqliteTable("doc", { id: c.id("doc"), createdAt: c.createdAt("created_at"), updatedAt: c.updatedAt("updated_at"), deletedAt: c.deletedAt("deleted_at", { private: true }) })`,
		)
		const read = dtos["doc"]?.["docDtoReadSchema"] as z.ZodObject
		expect(Object.keys(read.shape).sort()).toEqual(["createdAt", "id", "updatedAt"])
		expect(readCombEntityMeta(z.toJSONSchema(read))?.softDelete).toBeNull()
	})

	it("reads a plain nullable timestamp as its own nullable field", async () => {
		const dtos = await generatedDtos(
			"f10-nullable",
			`export const doc = sqliteTable("doc", { id: c.id("doc"), createdAt: c.createdAt("created_at"), updatedAt: c.timestamp("updated_at") })`,
		)
		const read = dtos["doc"]?.["docDtoReadSchema"] as z.ZodObject
		expect(read.safeParse({ createdAt: 1, id: "doc_1", updatedAt: null }).success).toBe(true)
	})
})
