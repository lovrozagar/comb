/**
 * The README's generator table is rendered here from GENERATORS, so it lists each generator the
 * CLI runs by name and no other, and each listed name is one `comb codegen -g` runs (AA4-6 of r24).
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { makeIo, projects, runCliWithFakes, writeTables } from "../../src/cli/__fixtures__/io.ts"
import { fixtureRoot } from "../../src/codegen/__fixtures__/temp.ts"
import { GENERATORS, type GeneratorName } from "../../src/codegen/config.ts"

const README = readFileSync(join(import.meta.dirname, "../../../../README.md"), "utf8")
const FROM = README.indexOf("### Generators")
/* the section up to the blank line that ends its table */
const SECTION = README.slice(FROM, README.indexOf("\n\n", README.indexOf("| Generator", FROM)))

// lookup-table: what the README says each generator writes
const OUTPUTS: Record<GeneratorName, string> = {
	columns: "column selections and table names, so query code never hard-codes strings",
	constraints: "the `ConstraintMap` for the error handlers",
	diagrams: "ChartDB DDL, relations JSON and a summary for AI context",
	dtos: "Zod schemas and TypeScript DTOs for create, update, and read",
	entities: "`generateId()` helpers bound to each table's id prefix",
	"enum-checks": "SQL CHECK constraints for `c.enum()` columns",
	"field-names": "a label for each field name, and their union type",
	fts: "the FTS5 metadata map, and its virtual tables, triggers and backfill SQL",
	manifest: "the model as JSON, for consumers that are not TypeScript",
	orm: "a typed `createXDb(handle)` client wired to the driver",
	relations: "Drizzle v1 `defineRelations()` from the foreign keys",
	rows: "row types inferred from the tables",
	translations: "the constraint map's error keys and their en-US messages",
}

/** The table as the formatter lays it out: each column padded to its widest cell */
function table(rows: readonly (readonly [string, string])[]): string {
	const all = [["Generator", "Output"] as const, ...rows]
	const widths = [0, 1].map((at) => Math.max(...all.map((row) => row[at as 0 | 1].length)))
	const line = (cells: readonly string[]): string =>
		`| ${cells.map((cell, at) => cell.padEnd(widths[at] as number)).join(" | ")} |`
	const rule = `| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`
	return [line(all[0]), rule, ...rows.map(line)].join("\n")
}

describe("README generator table", () => {
	it("is the table GENERATORS renders", () => {
		const rows = GENERATORS.toSorted().map((name) => [`\`${name}\``, OUTPUTS[name]] as const)
		expect(SECTION).toContain(table(rows))
	})

	const temp = projects(fixtureRoot())
	afterAll(temp.clean)
	const listed = [...SECTION.matchAll(/^\| `([a-z-]+)`/gm)].map((match) => match[1] as string)

	it.each(listed)("names %s, which -g runs and which writes a file", async (name) => {
		const dir = temp.make()
		writeTables(dir)
		writeFileSync(
			join(dir, "comb.config.ts"),
			`export default { databases: { core: ${JSON.stringify({
				dialect: "sqlite",
				driver: "d1",
				fts: { post: { columns: ["title"] } },
				tables: "./db.core.tables.ts",
			})} } }\n`,
		)
		const io = makeIo(dir)
		expect(await runCliWithFakes(["codegen", "-g", name], io), io.errors.join("\n")).toBe(0)
		const written = readdirSync(dir).filter((file) => !["comb.config.ts", "db.core.tables.ts"].includes(file))
		expect(written.filter((file) => file !== ".comb.codegen.gen.json")).not.toEqual([])
	})
})
