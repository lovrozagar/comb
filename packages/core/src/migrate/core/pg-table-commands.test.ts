/**
 * P10 of the 0.15.0 review: ENABLE TRIGGER, the half of DISABLE comb did not read, was unsafe as
 * unrecognized under a name no one wrote ("ENABLE TRIG ALL"); an unlisted command is named in the
 * SQL's own words.
 */
import { beforeAll, describe, expect, it } from "vitest"
import { ddlFindings } from "./pg-ddl.ts"
import { historyFacts } from "./pg-history.ts"
import type { Node } from "./pg-nodes.ts"
import { loadPostgresParser, postgresParser } from "./pg-parser.ts"

beforeAll(() => loadPostgresParser())

/** The DDL findings of `sql`'s one statement */
function rated(sql: string) {
	const [stmt] = postgresParser().parseSync(sql).stmts as Array<{ stmt: Node }>
	const [type, node] = Object.entries((stmt as { stmt: Node }).stmt)[0] as [string, Node]
	return ddlFindings(type, node, historyFacts(undefined, "public"))
}

describe("an ALTER TABLE's command on the whole table", () => {
	it.each([
		["ALTER TABLE t ENABLE TRIGGER x", "turns on trigger x of t, whose function runs on later writes"],
		["ALTER TABLE t ENABLE ALWAYS TRIGGER x", "turns on trigger x of t, whose function runs on later writes"],
		["ALTER TABLE t ENABLE REPLICA TRIGGER x", "turns on trigger x of t, whose function runs on later writes"],
		["ALTER TABLE t ENABLE TRIGGER ALL", "turns on every trigger of t, whose functions run on later writes"],
		["ALTER TABLE t ENABLE TRIGGER USER", "turns on every trigger of t, whose functions run on later writes"],
	])("rates %j cautious, as the trigger runs again", (sql, note) => {
		expect(rated(sql)).toEqual([{ level: "cautious", note }])
	})

	it.each([
		["ALTER TABLE t INHERIT base", "INHERIT"],
		["ALTER TABLE t NO INHERIT base", "NO INHERIT"],
		["ALTER TABLE t OF comp", "OF"],
		["ALTER TABLE t NOT OF", "NOT OF"],
		["ALTER TABLE t ENABLE ALWAYS RULE r", "ENABLE ALWAYS RULE"],
	])("rates %j unsafe, naming the command in the SQL's own words", (sql, words) => {
		expect(rated(sql)).toEqual([
			{ level: "unsafe", note: `comb does not recognize ALTER TABLE … ${words}; approve it in the file` },
		])
	})
})
