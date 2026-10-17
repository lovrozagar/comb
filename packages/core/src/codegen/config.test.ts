import { describe, expect, it } from "vitest"
import { defineCodegenConfig, GENERATORS } from "./config.ts"

describe("defineCodegenConfig", () => {
	it("returns the config it is given, so comb.config.ts can export it typed", () => {
		const config = { databases: { core: { generators: ["dtos" as const], tables: "./core.tables.ts" } } }
		expect(defineCodegenConfig(config)).toBe(config)
	})
})

describe("GENERATORS", () => {
	it("lists each generator once, in the order codegen runs them", () => {
		expect(new Set(GENERATORS).size).toBe(GENERATORS.length)
		expect(GENERATORS[0]).toBe("constraints")
		expect(GENERATORS.indexOf("translations")).toBeGreaterThan(GENERATORS.indexOf("constraints"))
	})
})
