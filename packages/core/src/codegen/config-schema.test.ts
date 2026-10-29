import { describe, expect, it } from "vitest"
import { codegenConfigSchema } from "./config-schema.ts"

describe("codegenConfigSchema (K14 of the 0.15.0 review)", () => {
	it("takes every key a database declares, as it is", () => {
		const config = {
			databases: {
				core: {
					dialect: "sqlite",
					driver: "d1",
					filePrefix: "db.core",
					fts: { post: { columns: ["title", "body"], tokenizer: "porter" } },
					generators: ["dtos", "orm"],
					output: { default: "./src/gen", dtos: "./src/dtos" },
					tables: "./tables.ts",
				},
			},
		}
		expect(codegenConfigSchema().parse(config)).toEqual(config)
	})

	it.each([
		["an output for no generator", { output: { dto: "./x" } }, ["databases", "core", "output"]],
		[
			"an FTS table's unknown key",
			{ fts: { post: { columns: ["a"], tokeniser: "x" } } },
			["databases", "core", "fts", "post"],
		],
		["a dialect comb does not write", { dialect: "mysql" }, ["databases", "core", "dialect"]],
		["no tables", { tables: undefined }, ["databases", "core", "tables"]],
	])("refuses %s, at its path", (_, more, path) => {
		const result = codegenConfigSchema().safeParse({ databases: { core: { tables: "./t.ts", ...more } } })
		expect(result.success).toBe(false)
		expect(result.error?.issues.map((issue) => issue.path)).toContainEqual(path)
	})
})
