/**
 * pg-storage.ts on its own (PA17 of r22b): what each statement leaves of where a relation keeps its
 * rows, and when a move is to where it already is. classify.pg-moves.test.ts rates the moves.
 */
import { beforeAll, describe, expect, it } from "vitest"
import { emptyFacts, type Facts, type Node } from "./pg-nodes.ts"
import { followTree } from "./pg-history.ts"
import { postgresParser, loadPostgresParser } from "./pg-parser.ts"
import { staysPut } from "./pg-storage.ts"

beforeAll(() => loadPostgresParser())

/** `facts` after `sql`, statement by statement */
function follow(sql: string, facts: Facts = emptyFacts("public")): Facts {
	for (const raw of postgresParser().parseSync(sql).stmts as unknown[]) followTree([raw], facts)
	return facts
}

/** The first command of `sql`, an ALTER TABLE */
function commandOf(sql: string): Node {
	const [raw] = postgresParser().parseSync(sql).stmts as Array<{ stmt: Node }>
	const alter = (raw as { stmt: Node }).stmt["AlterTableStmt"] as { cmds: Node[] }
	return (alter.cmds[0] as Node)["AlterTableCmd"] as Node
}

describe("followStorage", () => {
	it("keeps what the history wrote, and leaves to the target what it did not", () => {
		const facts = follow(
			"CREATE TABLE a (id int) USING heap TABLESPACE fast; CREATE TEMP TABLE b (id int); CREATE UNLOGGED TABLE c (id int)",
		)
		expect(facts.storage.get("a")).toEqual({ accessMethod: "heap", logged: true, tablespace: "fast" })
		expect(facts.storage.get("b")).toEqual({ accessMethod: undefined, logged: undefined, tablespace: undefined })
		expect(facts.storage.get("c")?.logged).toBe(false)
	})

	it("keeps the first of a table made again IF NOT EXISTS, which Postgres leaves as it was", () => {
		const facts = follow("CREATE UNLOGGED TABLE a (id int); CREATE TABLE IF NOT EXISTS a (id int) TABLESPACE fast")
		expect(facts.storage.get("a")).toEqual({ accessMethod: undefined, logged: false, tablespace: undefined })
		follow("CREATE TABLE IF NOT EXISTS n (id int) TABLESPACE fast", facts)
		expect(facts.storage.get("n")?.tablespace).toBe("fast")
	})

	it("follows a move of a table the history does not show, and SET ACCESS METHOD DEFAULT as unknown", () => {
		const facts = follow("ALTER TABLE g SET TABLESPACE fast; CREATE TABLE a (id int) USING heap")
		expect(facts.storage.get("g")).toEqual({ accessMethod: undefined, logged: undefined, tablespace: "fast" })
		follow("ALTER TABLE a SET ACCESS METHOD DEFAULT", facts)
		expect(facts.storage.get("a")?.accessMethod).toBeUndefined()
	})

	it("records nothing for an index the history does not show, nor for a command that moves nothing", () => {
		const facts = follow("ALTER INDEX ghost SET TABLESPACE fast; ALTER TABLE t ADD COLUMN x int")
		expect([...facts.storage.keys()]).toEqual([])
		expect([...facts.indexes.keys()]).toEqual([])
	})
})

describe("staysPut", () => {
	it("holds only for a move to where the relation is known to be", () => {
		const where = { accessMethod: "heap", logged: true, tablespace: "fast" }
		expect(staysPut(commandOf("ALTER TABLE t SET TABLESPACE fast"), where)).toBe(true)
		expect(staysPut(commandOf("ALTER TABLE t SET TABLESPACE slow"), where)).toBe(false)
		expect(staysPut(commandOf("ALTER TABLE t SET TABLESPACE fast"), undefined)).toBe(false)
		expect(staysPut(commandOf("ALTER TABLE t SET ACCESS METHOD DEFAULT"), where)).toBe(false)
		expect(staysPut(commandOf("ALTER TABLE t ADD COLUMN x int"), where)).toBe(false)
		expect(staysPut(commandOf("ALTER TABLE t SET UNLOGGED"), { logged: undefined })).toBe(false)
	})
})
