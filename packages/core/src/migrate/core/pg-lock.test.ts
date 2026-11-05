/**
 * The locks a Postgres statement takes on the relations it names and those it reaches (0005 of
 * r22b), read from a history's facts: a relation alone, or with its partitions and inheritance
 * children, ONLY leaving them out; none on a temporary table; the DEFAULT partition a new bound is
 * checked against; and the tables a change reaches through the foreign keys of its table.
 * tests/integration/postgres/lock-oracle-held.test.ts holds each to Postgres 17's pg_locks.
 */
import { beforeAll, describe, expect, it } from "vitest"
import { historyFacts } from "./pg-history.ts"
import {
	changeLocks,
	defaultOf,
	EXCLUSIVE,
	EXCLUSIVE_ALL,
	keyLocks,
	on,
	partitionLocks,
	SHARE,
	SHARE_ALL,
	truncateLocks,
} from "./pg-lock.ts"
import type { Node } from "./pg-nodes.ts"
import { loadPostgresParser, parsePostgres } from "./pg-parser.ts"
import { extractSchema } from "./schema.ts"

beforeAll(loadPostgresParser)

const HISTORY = [
	"CREATE TABLE users (id int PRIMARY KEY);",
	"CREATE TABLE orders (id int PRIMARY KEY, user_id int REFERENCES users (id));",
	"CREATE TABLE ev (id int, at date, user_id int REFERENCES users (id)) PARTITION BY RANGE (at);",
	"CREATE TABLE ev_old PARTITION OF ev FOR VALUES FROM ('2020-01-01') TO ('2021-01-01') PARTITION BY LIST (id);",
	"CREATE TABLE ev_old_1 PARTITION OF ev_old FOR VALUES IN (1);",
	"CREATE TABLE ev_rest PARTITION OF ev DEFAULT;",
	"CREATE TABLE base (id int);",
	"CREATE TABLE heir () INHERITS (base);",
].join("\n")

const facts = () => historyFacts(extractSchema(HISTORY, undefined, "postgres"), "public")

/** The one statement `sql` parses to, by its node type */
function statement(sql: string): Node {
	const [{ stmt }] = parsePostgres(sql).stmts as Array<{ stmt: Node }>
	return Object.values(stmt)[0] as Node
}

/** The relation an ALTER TABLE names, and its one command */
function alter(sql: string): { cmd: Node; relation: unknown } {
	const node = statement(sql)
	const [{ AlterTableCmd: cmd }] = node["cmds"] as Array<{ AlterTableCmd: Node }>
	return { cmd, relation: node["relation"] }
}

/** The locks an ALTER TABLE's command takes through its table's keys, sorted */
function reached(sql: string) {
	const { cmd, relation } = alter(sql)
	return changeLocks(relation, cmd, facts()).toSorted()
}

/** The locks a TRUNCATE takes, sorted */
const truncate = (sql: string) => truncateLocks(statement(sql), facts()).toSorted()

describe("the lock on a relation a statement names", () => {
	it("takes its partitions and their partitions with it, in its mode", () => {
		const { relation } = alter("ALTER TABLE ev ADD COLUMN n int;")
		expect(on(relation, facts(), EXCLUSIVE_ALL).toSorted()).toEqual([
			["ev", true],
			["ev_old", true],
			["ev_old_1", true],
			["ev_rest", true],
		])
		expect(on(relation, facts(), SHARE_ALL).every(([, reads]) => !reads)).toBe(true)
	})

	it("takes an inheritance child with its parent", () => {
		expect(on(alter("ALTER TABLE base ADD COLUMN n int;").relation, facts(), SHARE_ALL)).toEqual([
			["base", false],
			["heir", false],
		])
	})

	it("leaves the descendants out of a mode that does not recurse, and of a relation named ONLY", () => {
		expect(on(alter("ALTER TABLE ev ADD COLUMN n int;").relation, facts(), EXCLUSIVE)).toEqual([["ev", true]])
		expect(on(alter("ALTER TABLE ONLY ev ADD COLUMN n int;").relation, facts(), EXCLUSIVE_ALL)).toEqual([["ev", true]])
		expect(on(alter("ALTER TABLE base ADD COLUMN n int;").relation, facts(), SHARE)).toEqual([["base", false]])
	})

	it("takes none on a temporary table", () => {
		expect(on(alter("ALTER TABLE pg_temp.ev ADD COLUMN n int;").relation, facts(), EXCLUSIVE_ALL)).toEqual([])
	})

	it("reads a key's descendants without a relation", () => {
		expect(keyLocks("ev_old", EXCLUSIVE_ALL, facts())).toEqual([
			["ev_old", true],
			["ev_old_1", true],
		])
	})
})

describe("the locks a statement reaches past what it names", () => {
	it("takes the DEFAULT partition a new bound is checked against, and none where there is none", () => {
		expect(defaultOf(alter("ALTER TABLE ev ADD COLUMN n int;").relation, facts())).toEqual([["ev_rest", true]])
		expect(defaultOf(alter("ALTER TABLE ev_old ADD COLUMN n int;").relation, facts())).toEqual([])
	})

	it("takes SHARE ROW EXCLUSIVE on each table a new partition's keys reference", () => {
		expect(partitionLocks(alter("ALTER TABLE ev ADD COLUMN n int;").relation, facts())).toEqual([["users", false]])
		expect(partitionLocks(alter("ALTER TABLE base ADD COLUMN n int;").relation, facts())).toEqual([])
	})

	it("takes the tables whose keys reference a key a change drops or retypes, with their descendants", () => {
		const referencing = [
			["ev", true],
			["ev_old", true],
			["ev_old_1", true],
			["ev_rest", true],
			["orders", true],
		]
		expect(reached("ALTER TABLE users DROP CONSTRAINT users_pkey CASCADE;")).toEqual(referencing)
		expect(reached("ALTER TABLE users DROP COLUMN id CASCADE;")).toEqual(referencing)
		expect(reached("ALTER TABLE users ALTER COLUMN id TYPE bigint;")).toEqual(referencing)
		expect(reached("ALTER TABLE orders ALTER COLUMN user_id TYPE bigint;")).toEqual([["users", true]])
		expect(reached("ALTER TABLE users ADD COLUMN n int;")).toEqual([])
		expect(reached("ALTER TABLE pg_temp.users DROP COLUMN id CASCADE;")).toEqual([])
	})

	it("takes a TRUNCATE's tables with their descendants, and under CASCADE each table whose keys reach them", () => {
		expect(truncate("TRUNCATE base;")).toEqual([
			["base", true],
			["heir", true],
		])
		expect(truncate("TRUNCATE users CASCADE;").map(([key]) => key)).toEqual(
			expect.arrayContaining(["ev", "ev_old", "ev_old_1", "ev_rest", "orders", "users"]),
		)
		expect(truncate("TRUNCATE users;")).toEqual([["users", true]])
	})
})
