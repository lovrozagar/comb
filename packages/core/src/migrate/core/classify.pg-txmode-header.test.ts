/**
 * PA3 of r22b: comb rates a Postgres file by the transaction Atlas runs it in, which the file's
 * header decides by Atlas's rule. Each shape below heads a CREATE INDEX CONCURRENTLY, which Postgres
 * runs only outside a transaction: the verdicts are the pinned Atlas's (tests/structure/atlas-header.test.ts
 * holds comb's reader to it).
 */
import { describe, expect, it } from "vitest"
import { classifyMigration } from "./classify.ts"
import { extractSchema } from "./schema.ts"

const INDEX = "CREATE INDEX CONCURRENTLY t_x ON t (x);\n"

/** `head` before INDEX, rated after a history that makes t */
const rate = (head: string) =>
	classifyMigration(`${head}${INDEX}`, {
		before: extractSchema("CREATE TABLE t (x int);", undefined, "postgres"),
		dialect: "postgres",
	})

describe("comb reads a txmode header as Atlas does (PA3; sibling: comb's own -- comb:allow-unsafe: line)", () => {
	it.each([
		["a comment line first", "-- Build the index without blocking writes\n-- atlas:txmode none\n\n"],
		["a comment line after", "-- atlas:txmode none\n-- Build the index without blocking writes\n\n"],
		["a blank line holding spaces", "-- atlas:txmode none\n \t \n"],
		["CRLF", "-- atlas:txmode none\r\n\r\n"],
		["comb's allow-unsafe line first", "-- comb:allow-unsafe: index built online\n-- atlas:txmode none\n\n"],
		["comb's allow-unsafe line after", "-- atlas:txmode none\n-- comb:allow-unsafe: index built online\n\n"],
		["two spaces before none", "-- atlas:txmode  none\n\n"],
	])("runs the index outside a transaction under %s, as Atlas does", (_, head) => {
		expect(rate(head).safety).toBe("cautious")
	})

	it.each([
		["a tab after --", "--\tatlas:txmode none\n\n"],
		["no blank line", "-- atlas:txmode none\n"],
		["txmode file", "-- atlas:txmode file\n\n"],
	])("refuses the index under %s, which Atlas runs in the file's transaction", (_, head) => {
		expect(() => rate(head)).toThrow("Postgres runs CREATE INDEX CONCURRENTLY only outside a transaction")
	})

	it.each([
		["none-ish", "-- atlas:txmode none-ish\n\n", 'unknown txmode "none-ish" found in file directive'],
		["NONE", "-- atlas:txmode NONE\n\n", 'unknown txmode "NONE" found in file directive'],
		["all", "-- atlas:txmode all\n\n", 'txmode "all" is not allowed in file directive. Use "file" instead'],
		[
			"twice",
			"-- atlas:txmode none\n-- atlas:txmode none\n\n",
			'multiple txmode values found in file: ["none" "none"]',
		],
	])("refuses a header whose txmode is %s, quoting Atlas, which refuses the file", (_, head, atlas) => {
		expect(() => rate(head)).toThrow(`Atlas refuses this file's txmode (${JSON.stringify(atlas)})`)
	})
})
