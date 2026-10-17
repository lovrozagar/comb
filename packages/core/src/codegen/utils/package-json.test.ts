import { describe, expect, it } from "vitest"
import { readExports } from "./package-json.ts"

describe("readExports", () => {
	it("reads the subpath map whichever form package.json writes it in", () => {
		expect(readExports({ exports: "./index.ts" })).toEqual({ ".": "./index.ts" })
		expect(readExports({ exports: { ".": "./index.ts", "./x": { default: "./x.ts", types: "./x.d.ts" } } })).toEqual({
			".": "./index.ts",
			"./x": { default: "./x.ts", types: "./x.d.ts" },
		})
		expect(readExports({ exports: { default: "./index.ts", import: "./index.mjs" } })).toEqual({
			".": { default: "./index.ts", import: "./index.mjs" },
		})
		expect(readExports({})).toEqual({})
		expect(readExports({ exports: null })).toEqual({})
		expect(readExports({ exports: ["./a.ts"] })).toEqual({ ".": ["./a.ts"] })
	})
})
