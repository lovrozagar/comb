/* P16 of the 0.14.1 review: an ALTER DOMAIN rated as its column twin, through ddlFindings */
import { beforeAll, describe, expect, it } from "vitest"
import { historyFacts } from "./pg-history.ts"
import { ddlFindings } from "./pg-ddl.ts"
import type { Node } from "./pg-nodes.ts"
import { loadPostgresParser, postgresParser } from "./pg-parser.ts"

beforeAll(() => loadPostgresParser())

/** The DDL findings of `sql`'s one statement */
function rated(sql: string) {
	const [stmt] = postgresParser().parseSync(sql).stmts as Array<{ stmt: Node }>
	const [type, node] = Object.entries((stmt as { stmt: Node }).stmt)[0] as [string, Node]
	return ddlFindings(type, node, historyFacts(undefined, "public"))
}

describe("ddlFindings: an ALTER DOMAIN, as its column twin (P16)", () => {
	it("rates ALTER DOMAIN's DROP DEFAULT and DROP CONSTRAINT cautious, SET NOT NULL unsafe, and a validated check a scan", () => {
		const scan = { level: "lock", note: "scans every column of domain d, locking each table that holds one" }
		expect(rated("ALTER DOMAIN d DROP DEFAULT")).toEqual([{ level: "cautious" }])
		expect(rated("ALTER DOMAIN d DROP CONSTRAINT c")).toEqual([{ level: "cautious" }])
		expect(rated("ALTER DOMAIN public.d SET NOT NULL")).toEqual([
			{ level: "unsafe" },
			{ ...scan, note: "scans every column of domain public.d, locking each table that holds one" },
		])
		expect(rated("ALTER DOMAIN d ADD CONSTRAINT c CHECK (VALUE > 0)")).toEqual([scan])
		for (const sql of [
			"ALTER DOMAIN d SET DEFAULT 1",
			"ALTER DOMAIN d DROP NOT NULL",
			"ALTER DOMAIN d ADD CONSTRAINT c CHECK (VALUE > 0) NOT VALID",
			"ALTER DOMAIN d VALIDATE CONSTRAINT c",
		])
			expect(rated(sql), sql).toEqual([])
	})
})
