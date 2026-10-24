import { describe, expect, it } from "vitest"
import { outsideReach } from "./proof-outside.ts"

/** One opcode of an EXPLAIN listing, as the in-memory drivers return it */
const op = (opcode: string, fields: { p2?: number; p4?: string | null } = {}) => ({
	opcode,
	p1: 0,
	p2: fields.p2 ?? 0,
	p3: 0,
	p4: fields.p4 ?? null,
	p5: 0,
})

describe("outsideReach: what a program does outside its database, from its opcodes", () => {
	it.each([
		["ATTACH", [op("Function", { p2: 1, p4: "sqlite_attach(3)" }), op("Expire")]],
		["DETACH", [op("Function", { p2: 3, p4: "sqlite_detach(1)" })]],
		["load_extension", [op("Function", { p2: 2, p4: "load_extension(2)" })]],
		["load_extension", [op("PureFunc", { p2: 2, p4: "load_extension(1)" })]],
		["VACUUM INTO", [op("Vacuum", { p2: 1 })]],
	])("names %s", (named, ops) => {
		expect(outsideReach(ops)).toBe(named)
	})

	it("names nothing in a plain VACUUM, an ordinary function, or a program that calls none", () => {
		expect(outsideReach([op("Vacuum")])).toBeUndefined()
		expect(outsideReach([op("OpenWrite", { p2: 2 }), op("Function", { p4: "upper(1)" })])).toBeUndefined()
		expect(outsideReach([op("Init"), op("Halt")])).toBeUndefined()
	})
})
