/**
 * Check lets Postgres decide what no database runs (P13 of r19). On a postgres:// devUrl it replays
 * the history and the pending files on its server as Atlas applies them, baseline's own replay
 * (pg-replay.ts), and a statement Postgres refuses stops check with Postgres's message: a retype of
 * a column a view, a materialized view, a rule, a policy, a trigger's WHEN, a generated column or a
 * BEGIN ATOMIC function reads, and whatever else Postgres refuses on an empty database, which no
 * rating of the statement's text can list. Each statement whose scope is the server or another
 * database is left out, and check names it. A docker:// devUrl is Atlas's
 * own container, which comb cannot reach, and without the `postgres` package comb cannot connect:
 * then check says the replay did not run, and rates the files alone.
 *
 * The replay uses a role the server already holds, as the history may have made it on a shared
 * server; a pending file's CREATE ROLE of one stops apply, though, so check reads the target's
 * roles for those first (P7 of r21), on a docker:// devUrl too.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sqlFiles } from "./atlas-dir.ts"
import type { PgTarget } from "./atlas-target.ts"
import { type Connect, failureOf, loadPostgres } from "./pg-live-objects.ts"
import { nodeOf } from "./pg-outside-transaction.ts"
import { type HistoryFile, onDev } from "./pg-replay.ts"
import { heldRoles } from "./pg-replay-roles.ts"
import { pgRead } from "./pg-split.ts"
import { postgresOptionsOf } from "./pg-url.ts"
import { ReplayFailed } from "./replay-failed.ts"

/* why comb loads postgres.js here */
const REPLAYS = "replay the history and the pending files on devUrl in a check"

/* the line check prints when it replays nothing, and why */
const NOT_REPLAYED = "Check did not replay the pending files on devUrl"

/* what a refusal of check's stops */
const STOPS = "check applies nothing"

/* why check replays nothing on a docker:// devUrl */
const DOCKER = (devUrl: string): string =>
	`${devUrl} is Atlas's own container, which comb cannot reach, so a statement Postgres refuses on every database is found only when it applies; set devUrl to a postgres:// scratch database comb can connect to`

/**
 * Each role the `pending` files make, by CREATE ROLE or a rename to it, with the file that makes it
 * first; a role a file drops before that is left out, as apply makes it anew
 */
function rolesMade(pending: readonly HistoryFile[]): Map<string, string> {
	const made = new Map<string, string>()
	const dropped = new Set<string>()
	for (const { name, sql } of pending)
		for (const { tree } of pgRead(sql).statements) {
			const [type, node] = tree === undefined ? ["", {}] : nodeOf(tree)
			if (type === "DropRoleStmt")
				for (const role of node["roles"] as { RoleSpec: { rolename: string } }[]) dropped.add(role.RoleSpec.rolename)
			const role =
				type === "CreateRoleStmt"
					? String(node["role"])
					: type === "RenameStmt" && node["renameType"] === "OBJECT_ROLE"
						? String(node["newname"])
						: undefined
			if (role !== undefined && !dropped.has(role) && !made.has(role)) made.set(role, name)
		}
	return made
}

/**
 * Refuses a pending file's role `target`'s server already holds, which apply would stop at; one read
 * of its roles, a replay's own left out, which another check on the server holds only while it runs
 */
async function refuseHeldRoles(connect: Connect, target: PgTarget, pending: readonly HistoryFile[]): Promise<void> {
	const made = rolesMade(pending)
	if (made.size === 0) return
	const sql = connect({ ...postgresOptionsOf(target.url, "url"), max: 1 })
	let held: Set<string>
	try {
		held = await heldRoles(sql, [...made.keys()])
	} catch (error) {
		const failed = { field: "url", url: target.url, urls: [target.url, target.devUrl] } as const
		throw new ReplayFailed(`comb could not read the roles url's server holds: ${failureOf(error, failed)}; ${STOPS}`, {
			cause: error,
		})
	} finally {
		await sql.end()
	}
	for (const [role, file] of made)
		if (held.has(role)) throw new ReplayFailed(`role "${role}" already exists; apply would stop at ${file}`)
}

/**
 * The history and the pending `files`, in order, replayed on `target`'s dev server as Atlas applies
 * them, once no `pending` file makes a role the target's server holds; throws, naming the statement
 * and dev's error, for one dev refuses
 */
async function replayPending(
	{ print, target }: { print(line: string): void; target: PgTarget },
	{ files, pending }: { files: readonly HistoryFile[]; pending: readonly string[] },
	load: () => Promise<Connect> = () => loadPostgres(REPLAYS),
): Promise<void> {
	const docker = target.devUrl.startsWith("docker:")
	let connect: Connect
	try {
		connect = await load()
	} catch (error) {
		// reason: the postgres package is an optional peer; without it check rates the files alone, and says so
		print(`${NOT_REPLAYED}: ${docker ? DOCKER(target.devUrl) : (error as Error).message}`)
		return
	}
	const waiting = new Set(pending)
	await refuseHeldRoles(
		connect,
		target,
		files.filter((file) => waiting.has(file.name)),
	)
	if (docker) {
		print(`${NOT_REPLAYED}: ${DOCKER(target.devUrl)}`)
		return
	}
	await onDev(target, files, {
		adopted: (file, role) =>
			print(
				`Check adopted role ${role}, which ${file} made inside a statement the replay cannot leave out, as one it made: NOLOGIN NOSUPERUSER NOREPLICATION NOBYPASSRLS with no password on devUrl, dropped after it; apply makes it as the file says`,
			),
		after: async () => undefined,
		print,
		doing: "check replayed the history and the pending files there",
		leftOut: (file, sent, what) =>
			print(
				`Check left ${JSON.stringify(sent)} in ${file} out of its replay on devUrl: ${what} reaches past the database the replay runs in, so apply alone runs it`,
			),
		load: async () => connect,
		madeBare: (file, sent) =>
			print(
				`Check made the role of ${JSON.stringify(sent)} in ${file} NOLOGIN NOSUPERUSER NOREPLICATION NOBYPASSRLS, in no role the replay did not make, on devUrl: the replay needs only its name, so apply alone gives it the rest`,
			),
		movedTo: (file, sent, names) =>
			print(
				`Check ran ${JSON.stringify(sent)} in ${file} in pg_default on devUrl, not in ${names.map((name) => `tablespace ${name}`).join(" or ")}, as the replay left out the CREATE of that: where a relation lives changes nothing check reads, so apply alone runs it as written`,
			),
		stops: STOPS,
	})
}

/** The snapshot `copy`'s files through the last of `pending`, in order, as check replays them */
function throughPending(copy: string, pending: readonly string[]): HistoryFile[] {
	const names = sqlFiles(copy)
	return names
		.slice(0, names.indexOf(pending.at(-1) as string) + 1)
		.map((name) => ({ name, sql: readFileSync(join(copy, name), "utf8") }))
}

export { replayPending, throughPending }
