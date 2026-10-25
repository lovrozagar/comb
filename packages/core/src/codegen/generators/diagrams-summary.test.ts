import { describe, expect, it } from "vitest"
import type { Column, Table } from "./diagram-types.ts"
import { generateCompactAI } from "./diagrams-summary.ts"

const column = (name: string, reference?: Column["reference"]): Column => ({
	name,
	nullable: true,
	primaryKey: false,
	...(reference && { reference }),
	type: "TEXT",
})
const to = (target: string, onDelete?: string) => ({ column: "id", onDelete, table: target })
const table = (name: string, columns: Column[], foreignKeys: Table["foreignKeys"] = []): Table => ({
	columns,
	foreignKeys,
	key: [],
	name,
})

describe("generateCompactAI", () => {
	it("counts tables and keys, and lists a table's own columns or says it carries only common ones", () => {
		const summary = generateCompactAI(
			[table("ping", [column("id")]), table("post", [column("id"), column("title")])],
			[],
		)
		expect(summary).toContain("# 2 tables, 0 FKs\n")
		expect(summary).toContain("## Tables & Columns\n1. ping: (only common cols)\n2. post: title\n")
	})

	it("marks each delete rule, none for another, and puts the most referenced target first", () => {
		const summary = generateCompactAI(
			[
				table("cold", [column("id")]),
				table("hot", [column("id")]),
				table("a", [column("x", to("hot", "cascade")), column("y", to("hot", "restrict"))]),
				table("b", [column("z", to("cold", "set null")), column("w", to("hot", "no action"))]),
			],
			[],
		)
		expect(summary.slice(summary.indexOf("## FK refs"))).toBe(
			"## FK refs (target <- source.col)\n2 <- 3.x[c], 3.y[r], 4.w\n1 <- 4.z[n]",
		)
	})

	it("lists a composite foreign key once, by its columns (F46)", () => {
		const key = {
			columns: ["org_id", "user_id"],
			onDelete: "cascade",
			refColumns: ["org_id", "user_id"],
			table: "member",
		}
		const summary = generateCompactAI(
			[table("member", [column("org_id")]), table("grant", [column("org_id"), column("user_id")], [key])],
			[],
		)
		expect(summary).toContain("1 <- 2.(org_id, user_id)[c]")
	})
})
