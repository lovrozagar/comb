/**
 * P7 of the 0.14.1 review: the maintenance commands that hold an exclusive lock while they run,
 * read from their parse trees, so every spelling Postgres takes is warned of: VACUUM with FULL on,
 * a REINDEX that is not concurrent, and CLUSTER.
 */
import { beforeAll, describe, expect, it } from "vitest"
import { ddlFindings } from "./pg-ddl.ts"
import type { Node } from "./pg-nodes.ts"
import { loadPostgresParser, postgresParser } from "./pg-parser.ts"

beforeAll(() => loadPostgresParser())

/** The DDL findings of `sql`'s one statement */
function rated(sql: string) {
	const [stmt] = postgresParser().parseSync(sql).stmts as Array<{ stmt: Node }>
	const [type, node] = Object.entries((stmt as { stmt: Node }).stmt)[0] as [string, Node]
	return ddlFindings(type, node)
}

const LOCKED = [{ level: "lock", note: "holds an exclusive lock while it runs" }]

describe("a maintenance command's lock (P7)", () => {
	it("warns of VACUUM FULL in every spelling, a REINDEX that is not concurrent, and CLUSTER", () => {
		for (const sql of [
			"VACUUM FULL t",
			"VACUUM (FULL) t",
			"VACUUM (FULL true, ANALYZE) t",
			"VACUUM (FULL on) t",
			"VACUUM (FULL 1) t",
			"REINDEX TABLE t",
			"REINDEX INDEX i",
			"REINDEX (VERBOSE) TABLE t",
			"CLUSTER t USING i",
			"CLUSTER",
		])
			expect(rated(sql), sql).toEqual(LOCKED)
	})

	it("warns of none for a plain VACUUM, FULL turned off, or a concurrent REINDEX", () => {
		for (const sql of [
			"VACUUM t",
			"VACUUM (ANALYZE) t",
			"VACUUM (FULL false) t",
			"VACUUM (FULL off) t",
			"VACUUM (FULL 0) t",
			/* a float, which Postgres refuses as FULL's boolean, so no FULL runs */
			"VACUUM (FULL 1.5) t",
			"ANALYZE t",
			"REINDEX (CONCURRENTLY) TABLE t",
			"REINDEX TABLE CONCURRENTLY t",
		])
			expect(rated(sql), sql).toEqual([])
	})
})
