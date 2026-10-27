import { describe, expect, it } from "vitest"
import { byCodeUnit } from "./order.ts"

describe("byCodeUnit", () => {
	it("orders as a plain sort does, by code unit, whatever a locale would say", () => {
		const names = ["zebra", "aardvark", "yak", "item", "Zulu", "été", "jet"]
		expect([...names].sort(byCodeUnit)).toEqual([...names].sort())
		expect(byCodeUnit("a", "a")).toBe(0)
		expect(byCodeUnit("aa", "z")).toBe(-1)
		expect(byCodeUnit("y", "i")).toBe(1)
	})
})
