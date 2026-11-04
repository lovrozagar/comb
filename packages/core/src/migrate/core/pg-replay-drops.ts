/**
 * What a dev replay drops on devUrl's server (P2 and P4 of r21, P4 of r22): its own database, roles
 * and slots once it ends or a signal stops it (cleanUp), and what a replay killed past that left,
 * which the next replay or apply sweeps. A drop that fails never decides the verdict, and is said,
 * never left unsaid (r22b): what it left, dev's error, and whether a later sweep takes it, as a
 * stray of a refused window carries no tag a sweep finds. The replay database is dropped WITH
 * (FORCE), so a backend that came in after the cleanup ended the others cannot hold it.
 */
import { sqlIdentifier } from "../../codegen/utils/case.ts"
import type { PgTarget } from "./atlas-target.ts"
import { type Connect, failureOf, loadPostgres } from "./pg-live-objects.ts"
import { codeOf, leftovers, type Sql } from "./pg-replay-database.ts"
import type { Run } from "./pg-replay-roles.ts"
import { postgresOptionsOf } from "./pg-url.ts"

/** `step` run, its failure passed: one whose failure leaves something has it said by the drop that then fails (dropOr) */
async function settle(step: () => Promise<unknown>): Promise<void> {
	try {
		await step()
	} catch {
		// reason: a step before a drop, whose failure the drop it serves says when that drop fails in turn
	}
}

/** What a drop that failed left on devUrl's server, a database, role or slot by name, and whether a later sweep takes it */
type Left = { swept: boolean; what: string }

/** How a drop that failed is said: what it `left`, with dev's error */
type Leave = (left: Left, error: unknown) => void

/** `drop` run, a failure `leave`d: cleaning up never replaces the replay's verdict, and never leaves something unsaid */
async function dropOr(leave: Leave, left: Left, drop: () => Promise<unknown>): Promise<void> {
	try {
		await drop()
	} catch (error) {
		// reason: said by leave; a drop decides no verdict
		leave(left, error)
	}
}

/** A `leave` that prints, `failed` naming devUrl in dev's error */
function leaving(print: (line: string) => void, failed: Parameters<typeof failureOf>[1]): Leave {
	return ({ swept, what }, error) =>
		print(
			`comb could not drop ${what}, which a replay left on devUrl's server: ${failureOf(error, failed)}; ${swept ? "the next check or apply that reaches that server drops it" : "drop it there"}`,
		)
}

/** Drops the replication slot `slot`, if it is still there */
async function dropSlot(admin: Sql, slot: string): Promise<void> {
	await admin.unsafe("SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name = $1", [
		slot,
	])
}

/**
 * Drop `role`, unless it is not this role's to drop. Two sessions dropping one role race in
 * Postgres's catalog, and the loser fails without a SQLSTATE of its own (XX000, "could not find
 * tuple for role"), so a role gone after any failure is dropped; one something still depends on is
 * not, and fails
 */
async function dropRole(admin: Sql, role: string): Promise<void> {
	try {
		await admin.unsafe(`DROP ROLE IF EXISTS ${sqlIdentifier(role)}`, [])
	} catch (error) {
		// reason: another role made it, so it is not this run's to drop, nor its failure
		if (codeOf(error) === "42501") return
		const [left] = await admin.unsafe("SELECT 1 FROM pg_roles WHERE rolname = $1", [role])
		if (left !== undefined) throw error
	}
}

/**
 * Drop what replays over at `now` left, each drop that fails `leave`d: every replay database this
 * role may drop, whichever role made it (PR8 of r22b), once the backends its replay left in it are
 * ended (P4 of r22), and the tagged roles
 */
async function sweep(admin: Sql, now: number, leave: Leave): Promise<void> {
	const { databases, roles } = await leftovers(admin, now, true)
	for (const { name, pids } of databases) {
		for (const pid of pids) await settle(() => admin.unsafe("SELECT pg_terminate_backend($1)", [pid]))
		await dropOr(leave, { swept: true, what: `database ${name}` }, () =>
			admin.unsafe(`DROP DATABASE IF EXISTS ${sqlIdentifier(name)}`, []),
		)
	}
	for (const role of roles) await dropOr(leave, { swept: true, what: `role ${role}` }, () => dropRole(admin, role))
}

/* why comb loads postgres.js in an apply */
const SWEEPS = "sweep what a killed check left on a postgres:// devUrl's server"

/* how long apply waits to reach devUrl's server for its sweep, in seconds, where the URL sets no connect_timeout */
const SWEEP_TIMEOUT = 5

/**
 * The sweep, run on `target`'s dev server before an apply (P2 of r21): a check killed past its
 * cleanup leaves a role there, which apply's CREATE ROLE of it stops at where dev and target share
 * a server. Only that server matters, so apply asks the target's own server first, which it reaches
 * anyway, and connects to devUrl only when the target's holds what a sweep would take, waiting
 * SWEEP_TIMEOUT for it (PR7 of r22b). Housekeeping never stops an apply, so without the postgres
 * package, on Atlas's docker:// container or with nothing left it sweeps nothing, and a sweep that
 * fails is `print`ed and passed
 */
async function sweepDev(
	target: PgTarget,
	print: (line: string) => void,
	load: () => Promise<Connect> = () => loadPostgres(SWEEPS),
): Promise<void> {
	if (target.devUrl.startsWith("docker:")) return
	await settle(async () => {
		const connect = await load()
		const server = connect({ ...postgresOptionsOf(target.url, "url"), max: 1, onnotice: () => undefined })
		try {
			const { databases, roles } = await leftovers(server, Date.now(), false)
			if (databases.length + roles.length === 0) return
		} finally {
			await server.end()
		}
		const options = postgresOptionsOf(target.devUrl, "devUrl")
		const failed = { field: "devUrl", url: target.devUrl, urls: [target.devUrl, target.url] } as const
		const admin = connect({
			connect_timeout: SWEEP_TIMEOUT,
			...options,
			max: 1,
			onnotice: () => undefined,
		})
		try {
			await sweep(admin, Date.now(), leaving(print, failed))
		} catch (error) {
			// reason: housekeeping never stops an apply; what it left is said, and the next run that reaches devUrl sweeps it
			print(
				`Apply did not sweep what a killed check left on the target's server, as devUrl's server did not answer: ${failureOf(error, failed)}; a CREATE ROLE of a role it left stops apply until a check or apply that reaches devUrl sweeps it`,
			)
		} finally {
			await admin.end()
		}
	})
}

/**
 * `run`'s cleanup, each drop that fails `leave`d: its connection closed, a query in flight with it,
 * any backend still in its database ended, the slots a refused window added, which a drop waits on,
 * the database made no template and dropped, forcing out a backend that came in since, each role it
 * made, and that window's roles and idle databases, which no sweep takes
 */
async function cleanUp(run: Run, leave: Leave): Promise<void> {
	await settle(() => run.sql.end({ timeout: 0 }))
	await settle(() =>
		run.admin.unsafe(
			"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
			[run.database],
		),
	)
	for (const slot of run.strays.slots)
		await dropOr(leave, { swept: false, what: `replication slot ${slot}` }, () => dropSlot(run.admin, slot))
	await settle(() => run.admin.unsafe(`ALTER DATABASE ${run.database} IS_TEMPLATE false`, []))
	await dropOr(leave, { swept: true, what: `database ${run.database}` }, () =>
		run.admin.unsafe(`DROP DATABASE IF EXISTS ${run.database} WITH (FORCE)`, []),
	)
	for (const role of run.created)
		await dropOr(leave, { swept: true, what: `role ${role}` }, () => dropRole(run.admin, role))
	for (const name of run.strays.databases)
		await dropOr(leave, { swept: false, what: `database ${name}` }, () =>
			run.admin.unsafe(`DROP DATABASE IF EXISTS ${sqlIdentifier(name)}`, []),
		)
	for (const role of run.strays.roles)
		await dropOr(leave, { swept: false, what: `role ${role}` }, () => dropRole(run.admin, role))
}

export { cleanUp, dropOr, dropRole, dropSlot, type Leave, leaving, settle, sweep, sweepDev }
