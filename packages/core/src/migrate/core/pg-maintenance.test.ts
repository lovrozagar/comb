/**
 * P7 of the 0.14.1 review: the maintenance commands that hold an exclusive lock while they run,
 * read from their parse trees, so every spelling Postgres takes is warned of: VACUUM with FULL on,
 * a REINDEX that is not concurrent, and CLUSTER.
 */
import { beforeAll, describe, expect, it } from "vitest"
import { classifyMigration } from "./classify.ts"
import { extractSchema } from "./schema.ts"
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

/* r18 P12: a new partition of a parent with a DEFAULT partition makes Postgres scan the default too */
describe("a partition added beside the parent's default partition", () => {
	const EV =
		"CREATE TABLE ev (at date) PARTITION BY RANGE (at); CREATE TABLE ev_2020 PARTITION OF ev FOR VALUES FROM ('2020-01-01') TO ('2021-01-01'); CREATE TABLE ev_def PARTITION OF ev DEFAULT; CREATE TABLE ev_new (at date);"
	const locks = (later: string, history = EV) =>
		classifyMigration(later, { before: extractSchema(history, undefined, "postgres"), dialect: "postgres" })
			.lockWarnings
	const ATTACH = "ALTER TABLE ev ATTACH PARTITION ev_new FOR VALUES FROM ('2021-01-01') TO ('2022-01-01');"
	const BOTH =
		"scans ev_new, and the default partition ev_def, under an exclusive lock to check their bounds; add a CHECK constraint matching the bound to ev_new and one excluding it to ev_def, each NOT VALID, VALIDATE them, then ATTACH"

	it("names the default partition and its own CHECK on an ATTACH", () => {
		expect(locks(ATTACH)).toEqual([expect.stringMatching(/^ALTER TABLE ev ATTACH PARTITION ev_new .* \((.*)\)$/)])
		expect(locks(ATTACH)[0]).toContain(`(${BOTH})`)
	})

	it("names the default partition on a CREATE TABLE … PARTITION OF, which scans it", () => {
		const create = "CREATE TABLE ev_2022 PARTITION OF ev FOR VALUES FROM ('2022-01-01') TO ('2023-01-01');"
		const [warning, ...rest] = locks(create)
		expect([warning?.startsWith("CREATE TABLE ev_2022 PARTITION OF ev"), rest]).toEqual([true, []])
		expect(warning).toContain(
			"(scans the default partition ev_def under an exclusive lock to check no row of it belongs to ev_2022; add a CHECK constraint excluding the new bound to ev_def NOT VALID, VALIDATE it, then create the partition)",
		)
		expect(locks(create, EV.replace("CREATE TABLE ev_def PARTITION OF ev DEFAULT;", ""))).toEqual([])
	})

	it("follows the default partition through an ATTACH, a rename, a detach and a drop", () => {
		const attached = EV.replace(
			"CREATE TABLE ev_def PARTITION OF ev DEFAULT;",
			"CREATE TABLE d (at date); ALTER TABLE ev ATTACH PARTITION d DEFAULT;",
		)
		expect(locks(ATTACH, attached).join()).toContain("the default partition d,")
		expect(locks(ATTACH, `${EV} ALTER TABLE ev_def RENAME TO ev_rest;`).join()).toContain(
			"the default partition ev_rest,",
		)
		const alone = "scans ev_new under an exclusive lock to check its bound"
		expect(locks(ATTACH, `${EV} ALTER TABLE ev DETACH PARTITION ev_def;`).join()).toContain(alone)
		expect(locks(ATTACH, `${EV} DROP TABLE ev_def;`).join()).toContain(alone)
	})

	it("keeps the default partition through a detach or drop of another, and names none when the default is attached", () => {
		const kept = "the default partition ev_def,"
		expect(locks(ATTACH, `${EV} ALTER TABLE ev DETACH PARTITION ev_2020;`).join()).toContain(kept)
		expect(locks(ATTACH, `${EV} DROP TABLE ev_2020;`).join()).toContain(kept)
		const second = "ALTER TABLE ev ATTACH PARTITION ev_new DEFAULT;"
		expect(locks(second).join()).toContain("(scans ev_new under an exclusive lock to check its bound;")
	})
})
