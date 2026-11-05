/**
 * PR2 of r22b: a function that acts on the server, called at a statement's top level, reaches past
 * the replay's database as the statements in BEYOND do, so the replay leaves it out and names it,
 * and apply alone runs it. Hidden in a DO block, a replication slot it makes is read from the
 * server's committed catalogs (P2 of r22) and refused when the file names it. apply is the oracle.
 */
import pg from "pg"
import { afterEach, describe, expect, it } from "vitest"
import { SERVER_CALLS } from "../../../src/migrate/core/pg-server-calls.ts"
import { pgCheck, T } from "../support/pg-check.ts"
import { pgUrl, withScratchDb } from "../support/pg.ts"
import { LOOPBACK, query, roleOf, testRoles, unique } from "../support/pg-roles.ts"

const { checked, checkThenApply } = pgCheck()

/* a txmode none file's head, its change approved */
const NONE = "-- atlas:txmode none\n\n-- comb:allow-unsafe: the test's change\n"

/** The line check prints for `sent`, in the pending file, left out as a call of `call` */
const left = (sent: string, call: string) =>
	`Check left ${JSON.stringify(sent)} in 20260102000000_two.sql out of its replay on devUrl: a call of ${call} reaches past the database the replay runs in, so apply alone runs it`

/** The replication slot named `slot` on the server, if it exists */
const slotOf = (slot: string) =>
	query(pgUrl(), `SELECT slot_name FROM pg_replication_slots WHERE slot_name = '${slot}'`)

/** Drops the replication slot named `slot`, if it exists */
const dropSlot = (slot: string) =>
	query(pgUrl(), `SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name = '${slot}'`)

describe("a call that acts on the server is left out and named (PR2; sibling: BEYOND's statements, P2's DO-hidden dblink)", () => {
	const slot = unique("comb_t_slot")
	afterEach(() => dropSlot(slot))

	it.each([
		["a txmode none file", NONE],
		["a file in a transaction", "-- comb:allow-unsafe: the test's change\n"],
	])(
		"leaves a slot's making out of the replay in %s, names it, and apply makes it",
		async (_, head) => {
			const sent = `SELECT pg_create_physical_replication_slot('${slot}', true)`
			const out: string[] = []
			const ran = await checkThenApply(T, `${head}${sent};\n`, out)
			expect({ ran, slot: await slotOf(slot) }).toEqual({
				ran: { apply: undefined, check: undefined },
				slot: [{ slot_name: slot }],
			})
			expect(out).toContain(left(sent, "pg_create_physical_replication_slot"))
		},
		60_000,
	)
})

describe("a dblink connection's every call is left out with it (PR2; sibling: a slot's making)", () => {
	it("leaves a dblink session's every call out, names each, and apply runs them", async () => {
		const sent = [
			`SELECT dblink_connect('comb_t_link', ${LOOPBACK})`,
			"SELECT dblink_open('comb_t_link', 'cur', 'SELECT 1')",
			"SELECT * FROM dblink_fetch('comb_t_link', 'cur', 1) AS r(n int)",
			"SELECT dblink_disconnect('comb_t_link')",
		]
		const history = `${T}-- comb:allow-unsafe: the test's history\nCREATE EXTENSION IF NOT EXISTS dblink;\n`
		const out: string[] = []
		const ran = await checkThenApply(history, `${NONE}${sent.join(";\n")};\n`, out)
		expect(ran).toEqual({ apply: undefined, check: undefined })
		expect(out.filter((line) => line.startsWith("Check left"))).toEqual(
			sent.map((line, i) =>
				left(line, ["dblink_connect", "dblink_open", "dblink_fetch", "dblink_disconnect"][i] as string),
			),
		)
	}, 60_000)

	it("leaves dblink_exec's CREATE ROLE out, names it, and apply runs it", async () => {
		const [role] = testRoles("comb_t_call")
		const sent = `SELECT dblink_exec(${LOOPBACK}, 'CREATE ROLE ${role}')`
		const out: string[] = []
		const history = `${T}-- comb:allow-unsafe: the test's history\nCREATE EXTENSION IF NOT EXISTS dblink;\n`
		const { refused: check } = await checked(history, `${NONE}${sent};\n`)
		const afterCheck = await roleOf(role)
		const { apply } = await checkThenApply(history, `${NONE}${sent};\n`, out)
		expect({ afterCheck, apply, check, role: await roleOf(role) }).toEqual({
			afterCheck: [],
			apply: undefined,
			check: undefined,
			role: [{ rolconnlimit: -1, rolname: role }],
		})
		expect(out).toContain(left(sent, "dblink_exec"))
	}, 60_000)
})

describe("a backend another session holds stays its own (PR2; sibling: the replay's cleanup ending its database's backends)", () => {
	it("leaves another session alive through check when the file ends it", async () => {
		const tag = unique("comb_t_victim")
		const session = new pg.Client({ application_name: tag, connectionString: pgUrl() })
		const ended: unknown[] = []
		session.on("error", (error) => ended.push(error))
		await session.connect()
		try {
			const sent = `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = '${tag}'`
			const { out, refused } = await checked(T, `${NONE}${sent};\n`)
			const alive = await session.query("SELECT 1 AS n").then(
				(result) => result.rows,
				(error: Error) => error.message,
			)
			expect({ alive, ended, refused }).toEqual({ alive: [{ n: 1 }], ended: [], refused: undefined })
			expect(out).toContain(left(sent, "pg_terminate_backend"))
		} finally {
			await session.end()
		}
	}, 60_000)
})

/* P2 of r22 reads the server's committed catalogs; a slot is a row of one, read by its name */
describe("a slot a DO block makes is the file's (PR2; sibling: P2's DO-hidden dblink role)", () => {
	const slot = unique("comb_t_slot")
	afterEach(() => dropSlot(slot))

	it.each([
		["a txmode none file", NONE],
		["a file in a transaction", "-- comb:allow-unsafe: the test's change\n"],
	])(
		"refuses one in %s, naming it, and leaves no slot behind",
		async (_, head) => {
			const { refused } = await checked(
				T,
				`${head}DO $$ BEGIN PERFORM pg_create_physical_replication_slot('${slot}', true); END $$;\n`,
			)
			expect({ refused, slot: await slotOf(slot) }).toEqual({
				refused: expect.stringContaining(`replication slot ${slot} added`),
				slot: [],
			})
		},
		60_000,
	)

	it("passes a slot another session makes during a bare statement, which the file does not name", async () => {
		const pending = checked(T, `${NONE}SELECT pg_sleep(1.5);\n`)
		for (let i = 0; i < 200; i++) {
			const [sleeping] = await query(
				pgUrl(),
				"SELECT 1 AS n FROM pg_stat_activity WHERE query = 'SELECT pg_sleep(1.5)' AND datname LIKE 'comb\\_replay\\_%'",
			)
			if (sleeping !== undefined) break
			await new Promise((tick) => setTimeout(tick, 25))
		}
		await query(pgUrl(), `SELECT pg_create_physical_replication_slot('${slot}', true)`)
		expect((await pending).refused).toBeUndefined()
	}, 60_000)
})

/* the pg_catalog functions Postgres revokes from PUBLIC that only read, or write the database's own large objects */
const READS: readonly string[] = [
	"lo_import",
	"pg_config",
	"pg_current_logfile",
	"pg_get_backend_memory_contexts",
	"pg_get_shmem_allocations",
	"pg_hba_file_rules",
	"pg_ident_file_mappings",
	"pg_ls_archive_statusdir",
	"pg_ls_dir",
	"pg_ls_logdir",
	"pg_ls_logicalmapdir",
	"pg_ls_logicalsnapdir",
	"pg_ls_replslotdir",
	"pg_ls_tmpdir",
	"pg_ls_waldir",
	"pg_read_binary_file",
	"pg_read_file",
	"pg_replication_origin_oid",
	"pg_replication_origin_progress",
	"pg_replication_origin_session_is_setup",
	"pg_replication_origin_session_progress",
	"pg_show_all_file_settings",
	"pg_show_replication_origin_status",
	"pg_stat_file",
	"pg_stat_have_stats",
]

describe("the server calls' list (PR2; sibling: the scope table's structure test)", () => {
	it("rules every pg_catalog function Postgres revokes from PUBLIC once: acting on the server, or reading", async () => {
		const revoked = (
			await query(
				pgUrl(),
				"SELECT DISTINCT p.proname FROM pg_proc p WHERE p.pronamespace = 'pg_catalog'::regnamespace AND NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') ORDER BY 1",
			)
		).map((row) => String(row["proname"]))
		const ruled = [...SERVER_CALLS, ...READS]
		expect(revoked.length).toBeGreaterThan(50)
		expect(revoked.filter((name) => !ruled.includes(name))).toEqual([])
		expect(READS.filter((name) => SERVER_CALLS.has(name))).toEqual([])
		expect(READS.filter((name) => !revoked.includes(name))).toEqual([])
	})
})

/** The subscriptions whose name starts with `prefix`, each with the database it is in */
const subscriptionsOf = (prefix: string) =>
	query(
		pgUrl(),
		`SELECT s.subname, d.datname FROM pg_subscription s JOIN pg_database d ON d.oid = s.subdbid WHERE s.subname LIKE '${prefix}%'`,
	)

/** Drops what a failed run left: each subscription named from `prefix`, from inside its database, then that database */
async function dropSubscriptions(prefix: string): Promise<void> {
	for (const { datname, subname } of await subscriptionsOf(prefix)) {
		const into = new URL(pgUrl() as string)
		into.pathname = `/${String(datname)}`
		for (const step of ["DISABLE", "SET (slot_name = NONE)"])
			await query(into.href, `ALTER SUBSCRIPTION ${String(subname)} ${step}`)
		await query(into.href, `DROP SUBSCRIPTION ${String(subname)}`)
		await query(pgUrl(), `DROP DATABASE IF EXISTS ${String(datname)} WITH (FORCE)`)
	}
}

/* a subscription lives in the database it is made in, which Postgres will not drop while it holds one */
describe("a subscription the file makes in the replay's database dies with it (sibling: a slot a DO block makes)", () => {
	const prefix = unique("comb_t_sub")
	afterEach(() => dropSubscriptions(prefix))

	it.each([
		["spelled", `'${prefix}'`],
		["built at run time", `'${prefix}_' || pg_backend_pid()`],
	])(
		"refuses one whose name is %s, and leaves neither it nor the replay's database behind",
		async (_, name) => {
			const made = `EXECUTE format('CREATE SUBSCRIPTION %I CONNECTION ''dbname=postgres'' PUBLICATION p WITH (connect = false, enabled = false, create_slot = false)', ${name})`
			const { out, refused } = await checked(T, `${NONE}DO $$ BEGIN COMMIT; ${made}; END $$;\n`)
			expect({
				left: out.filter((line) => line.startsWith("comb could not drop")),
				refused,
				subscriptions: await subscriptionsOf(prefix),
			}).toEqual({
				left: [],
				refused: expect.stringMatching(
					new RegExp(`comb drops the database it replays in, and subscription ${prefix}\\S* in it; check applies`),
				),
				subscriptions: [],
			})
			expect(refused).not.toContain("which comb cannot undo")
		},
		60_000,
	)

	it("leaves a subscription in a database no replay made, whichever drops it is in", async () => {
		await withScratchDb(async (url) => {
			const kept = `${prefix}_kept`
			await query(
				url,
				`CREATE SUBSCRIPTION ${kept} CONNECTION 'dbname=postgres' PUBLICATION p WITH (connect = false, enabled = false, create_slot = false)`,
			)
			try {
				const { refused } = await checked(T, `${NONE}SELECT 1;\n`)
				expect({ refused, subscriptions: (await subscriptionsOf(prefix)).map(({ subname }) => subname) }).toEqual({
					refused: undefined,
					subscriptions: [kept],
				})
			} finally {
				await dropSubscriptions(prefix)
			}
		})
	}, 60_000)
})
