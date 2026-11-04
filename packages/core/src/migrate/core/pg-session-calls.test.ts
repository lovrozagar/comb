/**
 * The pg_catalog calls of pg-session-calls.ts (PA1 of r22b), each doing to a file's run what its
 * list says: a call that leaves the session as it was keeps the file in its run, a call that reads
 * what an earlier one left starts a run, and a call no list names ends one; the lists are held to
 * the server's own pg_proc in tests/integration/postgres/session-calls.test.ts
 */
import { beforeAll, describe, expect, it } from "vitest"
import { loadPostgresParser } from "./pg-parser.ts"
import { CATALOG_CALLS, READS_SESSION, VOLATILE_HARMLESS } from "./pg-session-calls.ts"
import { sessionRuns } from "./pg-session.ts"
import { pgRead } from "./pg-split.ts"

beforeAll(loadPostgresParser)

const T = "CREATE TABLE t (id int);\n"

/** The runs of three files whose second calls pg_catalog's `name`, by their positions */
const runs = (name: string): number[][] => {
	const files = [T, `SELECT pg_catalog.${name}();\n`, T].map((sql, i) => ({ i, read: pgRead(sql) }))
	return sessionRuns(files).map((run) => run.map((file) => file.i))
}

describe("the pg_catalog calls a file's run is read by (PA1 of r22b)", () => {
	it.each([...CATALOG_CALLS].filter((name) => !READS_SESSION.has(name)))(
		"keeps a file calling %s in its run",
		(name) => {
			expect(runs(name)).toEqual([[0, 1, 2]])
		},
	)

	it.each([...READS_SESSION])("starts a run at a file calling %s, which reads what an earlier one left", (name) => {
		expect(runs(name)).toEqual([[0], [1, 2]])
	})

	it("names each volatile one and each reader among the calls", () => {
		expect([...VOLATILE_HARMLESS, ...READS_SESSION].filter((name) => !CATALOG_CALLS.has(name))).toEqual([])
	})

	it("ends a run at a call no list names", () => {
		expect(runs("pg_advisory_lock")).toEqual([[0, 1], [2]])
	})
})
