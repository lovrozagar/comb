/**
 * comb's lock warnings held to Postgres's own locks (PA8 and PA9 of r22b). Each case runs a file
 * as Atlas does, in one transaction after the files before it, reads what that transaction holds from
 * pg_locks, and rates the same file: comb warns of a statement where the lock it scans or builds
 * under blocks the table, and names its sibling where the lock does not.
 */
import pg from "pg"
import { beforeAll, describe, expect, it } from "vitest"
import { classifyMigration } from "../../../src/migrate/core/classify.ts"
import { loadPostgresParser } from "../../../src/migrate/core/pg-parser.ts"
import { extractSchema } from "../../../src/migrate/core/schema.ts"
import { withScratchDb } from "../support/pg.ts"

beforeAll(loadPostgresParser)

const HISTORY = [
	"CREATE TABLE users (id int PRIMARY KEY, n int);",
	"CREATE TABLE orders (id int, user_id int);",
	"CREATE DOMAIN posint AS int;",
	"CREATE TABLE dm (id int, v posint);",
].join("\n")

/** What a Postgres lock mode blocks of other sessions' reads and writes */
function blocking(modes: readonly string[]): string | undefined {
	if (modes.includes("AccessExclusiveLock")) return "reads and writes"
	const writes = ["ShareLock", "ShareRowExclusiveLock", "ExclusiveLock"]
	return modes.some((mode) => writes.includes(mode)) ? "writes" : undefined
}

/** What the transaction of `file` holds blocked by table at its end, the `earlier` files committed after HISTORY */
async function heldBy(url: string, file: string, earlier: readonly string[] = []): Promise<Record<string, string>> {
	const client = new pg.Client({ connectionString: url })
	await client.connect()
	try {
		await client.query(HISTORY)
		for (const sql of earlier) await client.query(sql)
		await client.query("BEGIN")
		await client.query(file)
		const { rows } = await client.query<{ modes: string[]; relname: string }>(
			"SELECT c.relname, array_agg(l.mode::text) AS modes FROM pg_locks l JOIN pg_class c ON c.oid = l.relation WHERE l.pid = pg_backend_pid() AND c.relkind IN ('r', 'p') AND c.relnamespace = 'public'::regnamespace GROUP BY 1",
		)
		await client.query("ROLLBACK")
		return Object.fromEntries(
			rows.flatMap(({ modes, relname }) => {
				const blocks = blocking(modes)
				return blocks === undefined ? [] : [[relname, blocks]]
			}),
		)
	} finally {
		await client.end()
	}
}

/** comb's lock warnings on `file`, the `earlier` files read into its history */
const warned = (file: string, earlier: readonly string[] = []): string[] =>
	classifyMigration(file, {
		before: extractSchema([HISTORY, ...earlier].join("\n"), undefined, "postgres"),
		dialect: "postgres",
	}).lockWarnings

/** Postgres's locks at the end of `file` beside comb's warnings on it */
const both = async (url: string, file: string, earlier: readonly string[] = []) => ({
	held: await heldBy(url, file, earlier),
	warned: warned(file, earlier),
})

const CHECK_ADD = "ALTER TABLE users ADD CONSTRAINT pos CHECK (n > 0) NOT VALID;"
const CHECK_VALIDATE = "ALTER TABLE users VALIDATE CONSTRAINT pos;"
const FK_ADD = "ALTER TABLE orders ADD CONSTRAINT fk FOREIGN KEY (user_id) REFERENCES users (id) NOT VALID;"
const FK_VALIDATE = "ALTER TABLE orders VALIDATE CONSTRAINT fk;"
const HELD = "the ADD's lock is held through this scan; validate in a later file"

describe("a NOT VALID ADD and its VALIDATE on Postgres 17 (PA8; sibling: the two-file NOT VALID shape)", () => {
	it("warns of a CHECK's VALIDATE in the ADD's file, which scans while the transaction blocks reads", async () => {
		await withScratchDb(async (url) => {
			expect(await both(url, `${CHECK_ADD}\n${CHECK_VALIDATE}\n`)).toEqual({
				held: { users: "reads and writes" },
				warned: [
					`${CHECK_VALIDATE.slice(0, -1)} (scans users while this file holds it locked against reads and writes; ${HELD})`,
				],
			})
		})
	}, 60_000)

	it("warns of a foreign key's VALIDATE in the ADD's file, which scans while both tables' writes wait", async () => {
		await withScratchDb(async (url) => {
			expect(await both(url, `${FK_ADD}\n${FK_VALIDATE}\n`)).toEqual({
				held: { orders: "writes", users: "writes" },
				warned: [
					`${FK_VALIDATE.slice(0, -1)} (scans orders while this file holds orders and users locked against writes; ${HELD})`,
				],
			})
		})
	}, 60_000)

	it("warns of neither VALIDATE in a later file, which blocks no read or write", async () => {
		await withScratchDb(async (url) => {
			expect(await both(url, `${CHECK_VALIDATE}\n${FK_VALIDATE}\n`, [CHECK_ADD, FK_ADD])).toEqual({
				held: {},
				warned: [],
			})
		})
	}, 60_000)
})

describe("a domain's VALIDATE on Postgres 17 (PA9; sibling: the table CHECK's VALIDATE)", () => {
	const DOMAIN_ADD = "ALTER DOMAIN posint ADD CONSTRAINT pos CHECK (VALUE > 0) NOT VALID;"
	const DOMAIN_VALIDATE = "ALTER DOMAIN posint VALIDATE CONSTRAINT pos;"

	it("warns of a domain's VALIDATE in a later file, which blocks writes to each table holding the domain", async () => {
		await withScratchDb(async (url) => {
			expect(await both(url, `${DOMAIN_VALIDATE}\n`, [DOMAIN_ADD])).toEqual({
				held: { dm: "writes" },
				warned: [
					`${DOMAIN_VALIDATE.slice(0, -1)} (scans every column of domain posint, and blocks writes to each table that holds one while it scans)`,
				],
			})
		})
	}, 60_000)

	it("warns of no table CHECK's VALIDATE in a later file, which blocks nothing", async () => {
		await withScratchDb(async (url) => {
			expect(await both(url, `${CHECK_VALIDATE}\n`, [CHECK_ADD])).toEqual({ held: {}, warned: [] })
		})
	}, 60_000)
})
