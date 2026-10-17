import { describe, expect, it } from "vitest"
import { EMPTY_ARR, EMPTY_OBJ } from "./empty.ts"

describe("EMPTY_OBJ and EMPTY_ARR", () => {
	it("are frozen and empty, and the object has no prototype to inherit keys from", () => {
		expect(Object.isFrozen(EMPTY_OBJ) && Object.isFrozen(EMPTY_ARR)).toBe(true)
		expect(Object.keys(EMPTY_OBJ)).toEqual([])
		expect(EMPTY_ARR).toEqual([])
		expect(Object.getPrototypeOf(EMPTY_OBJ)).toBeNull()
	})
})
