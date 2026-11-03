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
					partitions: { audit: ["audit_2026"] },
					tables: "./tables.ts",
				},
			},
		}
		expect(codegenConfigSchema().parse(config)).toEqual(config)
	})

	/* AD2 of the area D review: an explicit undefined is the key left out, as CodegenConfig declares and codegen reads it */
	it("takes an output set to undefined as that generator's output left out", () => {
		const config = { databases: { core: { output: { default: "./src/gen", dtos: undefined }, tables: "./t.ts" } } }
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
		/* r18 K5: an FTS table of no column generates SQL SQLite refuses */
		[
			"an FTS table with no column",
			{ fts: { post: { columns: [] } } },
			["databases", "core", "fts", "post", "columns"],
		],
		/* Q7 of r18: a partitioned table of no partition, or one of no name, lists nothing a map can read */
		[
			"a partitioned table with no partition",
			{ partitions: { audit: [] } },
			["databases", "core", "partitions", "audit"],
		],
		["a partition of no name", { partitions: { audit: [""] } }, ["databases", "core", "partitions", "audit", 0]],
		["no tables", { tables: undefined }, ["databases", "core", "tables"]],
	])("refuses %s, at its path", (_, more, path) => {
		const result = codegenConfigSchema().safeParse({ databases: { core: { tables: "./t.ts", ...more } } })
		expect(result.success).toBe(false)
		expect(result.error?.issues.map((issue) => issue.path)).toContainEqual(path)
	})
})

/* S6 of r19 (K4's sibling in comb.config.ts), and the blank names and paths beside it */
describe("codegenConfigSchema on what it declares empty or blank", () => {
	it("refuses a config that declares no database, as comb.migrate.config.ts's schema does", () => {
		const result = codegenConfigSchema().safeParse({ databases: {} })
		expect(result.error?.issues.map((issue) => issue.message)).toEqual(["databases declares no database"])
	})

	it.each([
		["tables", { tables: "  " }],
		["filePrefix", { filePrefix: " ", tables: "./t.ts" }],
		["output", { output: { dtos: "\t" }, tables: "./t.ts" }],
		["fts", { fts: { post: { columns: [" "] } }, tables: "./t.ts" }],
		["partitions", { partitions: { audit: ["  "] }, tables: "./t.ts" }],
	])("refuses a blank %s", (field, database) => {
		const result = codegenConfigSchema().safeParse({ databases: { core: database } })
		expect(result.error?.issues.map((issue) => [issue.path[2], issue.message])).toEqual([
			[field, expect.stringMatching(/blank/)],
		])
	})
})
