import { describe, expect, it } from "vitest"
import { KEEPS, NOT_CURSOR, OPENS } from "./proof-opcodes.ts"

/* the walk reads an opcode by the first list that has it: one on two lists would be read two ways */
describe("the opcode lists the walk reads", () => {
	it("name each opcode once", () => {
		const all = [...OPENS, ...KEEPS, ...NOT_CURSOR]
		expect(all.length).toBe(new Set(all).size)
	})

	it("leave the opcodes that remove or rewrite rows to the walk's deny: none is kept or read as no cursor", () => {
		for (const opcode of ["Delete", "IdxDelete", "ResetSorter", "SorterInsert"])
			expect(KEEPS.has(opcode) || NOT_CURSOR.has(opcode) || OPENS.has(opcode)).toBe(false)
	})

	it("keep a cursor open for writing only through OpenWrite", () => {
		expect(OPENS.has("OpenWrite")).toBe(true)
		expect(KEEPS.has("Insert") && KEEPS.has("IdxInsert") && KEEPS.has("NewRowid")).toBe(true)
	})
})
