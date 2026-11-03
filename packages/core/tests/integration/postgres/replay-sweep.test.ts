/**
 * P2, P3 and P4 of r21: what a dev replay leaves on devUrl's server, here the target's too, as many
 * setups share one. A check killed by SIGINT or SIGTERM cleans up first, once, and ends as the signal
 * would; one killed past that is swept by the next check or apply at once, so apply's CREATE ROLE of
 * the role it made passes, while a live replay's database and role are never swept, nor a database
 * someone is in. The replay makes a role with no login or superuser, whatever the history says.
 */
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pg from "pg"
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { approveMigration } from "../../../src/migrate/core/approval.ts"
import { applyWithAtlas } from "../../../src/migrate/core/atlas-apply.ts"
import { hashDir } from "../../../src/migrate/core/atlas-dir.ts"
import { loadPostgresParser } from "../../../src/migrate/core/pg-parser.ts"
import { run } from "../../../src/migrate/core/process.ts"
import type { ParsedMigration } from "../../../src/migrate/types.ts"
import { pgUrl, withScratchDb } from "../support/pg.ts"
import { pauses, waitFor } from "../support/pg-pause.ts"
import { dropRoles as dropOnly, query, roleOf, unique } from "../support/pg-roles.ts"

beforeAll(loadPostgresParser)

let dir = ""
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "comb-pg-replay-sweep-"))
})
afterEach(() => rmSync(dir, { force: true, recursive: true }))

const UNSAFE = "-- comb:allow-unsafe: the test's history\n"

/* the go a paused history waits for */
const pause = pauses()

/** The files, named in order and hashed, in `at` */
function write(files: readonly string[], at = dir): void {
	files.forEach((sql, i) => writeFileSync(join(at, `20260101${String(i).padStart(6, "0")}_f${i}.sql`), sql))
	hashDir(run, at)
}

/** A history that makes `made` and then waits, at most a minute, until the test lets `resume` go */
const paused = (made: string, resume: string, role = `CREATE ROLE ${made};`): string[] => [
	`${UNSAFE}${role}\nCREATE TABLE t (id int PRIMARY KEY);\nGRANT SELECT ON t TO ${made};\n`,
	`${UNSAFE}${waitFor(resume)}`,
]

/** The options of a run of the directory against `url`, approving every file, collecting what it prints */
const options = (devUrl: string, url: string, out: string[] = []) => ({
	approve: (m: ParsedMigration) => approveMigration(m, { target: "core", yes: true }),
	dir,
	print: (line: string) => out.push(line),
	target: { devUrl, lockTimeout: "5s", schema: "public", url },
})

/** A check of the directory against `url`: what it printed, and why it refused */
async function check(devUrl: string, url: string): Promise<{ out: string[]; refused?: string | undefined }> {
	const out: string[] = []
	try {
		await applyWithAtlas({ ...options(devUrl, url, out), checkOnly: true })
		return { out }
	} catch (error) {
		return { out, refused: (error as Error).message }
	}
}

/** Until the server holds `role`, at most 30 s */
async function untilRole(role: string): Promise<void> {
	for (let tries = 0; (await roleOf(role)).length === 0; tries++) {
		if (tries > 600) throw new Error(`the replay never made ${role}`)
		await new Promise((done) => setTimeout(done, 50))
	}
}

/** Whether the server holds the database `name` */
const holds = async (name: string): Promise<boolean> =>
	(await query(pgUrl(), `SELECT 1 FROM pg_database WHERE datname = '${name}'`)).length > 0

/**
 * A check of the directory in a child process, under a shell that says how it ended, as a terminal
 * or a CI runner reads it; `kill` sends the child a signal, and `ended` is all it wrote, its end last
 */
function childCheck(devUrl: string, url: string) {
	const child = spawn(
		"sh",
		[
			"-c",
			'bun "$0" "$1"; echo "exit $?"',
			join(import.meta.dirname, "../support/replay-child.ts"),
			JSON.stringify({ devUrl, dir, url }),
		],
		{ stdio: ["ignore", "pipe", "inherit"] },
	)
	let said = ""
	child.stdout.on("data", (chunk: Buffer) => {
		said += chunk.toString()
	})
	const ended = new Promise<string[]>((done) => child.on("close", () => done(said.trim().split("\n"))))
	const pid = async (): Promise<number> => {
		while (!/^pid \d+$/m.test(said)) await new Promise((done) => setTimeout(done, 20))
		return Number(/^pid (\d+)$/m.exec(said)?.[1])
	}
	return { ended, kill: async (signal: NodeJS.Signals) => process.kill(await pid(), signal) }
}

/** `roles` dropped, with any replay database a failed run left that grants one of them CONNECT, which holds it */
async function dropRoles(...roles: string[]): Promise<void> {
	const held = await query(
		pgUrl(),
		`SELECT datname FROM pg_database WHERE datname LIKE 'comb\\_replay\\_%' AND (${roles.map((role) => `datacl::text LIKE '%${role}=%'`).join(" OR ")})`,
	)
	for (const { datname } of held) await query(pgUrl(), `DROP DATABASE IF EXISTS ${String(datname)} WITH (FORCE)`)
	await dropOnly(...roles)
}

/** The replay databases on the server that hold `role` by a grant, as a replay holds each role it made */
const replayDatabases = async (role: string): Promise<string[]> =>
	(
		await query(
			pgUrl(),
			`SELECT datname FROM pg_database WHERE datname LIKE 'comb\\_replay\\_%' AND datacl::text LIKE '%${role}=%'`,
		)
	).map((row) => String(row["datname"]))

/**
 * A check of `made`'s paused history killed by SIGKILL mid-replay, past any cleanup, its statement in
 * flight then let end, as a killed check's does: the replay database it left, holding `made`
 */
async function killedHard(
	dev: string,
	url: string,
	{ made, resume }: { made: string; resume: string },
): Promise<string> {
	write(paused(made, resume))
	const child = childCheck(dev, url)
	await untilRole(made)
	await child.kill("SIGKILL")
	expect((await child.ended).at(-1)).toBe("exit 137")
	await pause.go(resume)
	const left = await replayDatabases(made)
	expect(left).toHaveLength(1)
	return left[0] as string
}

describe("a check killed mid-replay", () => {
	it.each([
		["SIGINT", 130],
		["SIGTERM", 143],
	] as const)(
		"by %s cleans up once and ends as the signal would, leaving nothing",
		async (signal, code) => {
			const [made, resume] = [unique("comb_t_killed"), unique("comb_t_resume")]
			try {
				await withScratchDb((dev) =>
					withScratchDb(async (url) => {
						write(paused(made, resume))
						const child = childCheck(dev, url)
						await untilRole(made)
						await child.kill(signal)
						const said = await child.ended
						expect(said.at(-1)).toBe(`exit ${code}`)
						expect(said.filter((line) => line.startsWith("drop "))).toHaveLength(1)
						expect(await roleOf(made)).toEqual([])
						expect(await replayDatabases(made)).toEqual([])
					}),
				)
			} finally {
				await dropRoles(made)
			}
		},
		60_000,
	)

	it("by SIGKILL is swept by the next check at once", async () => {
		const [made, resume] = [unique("comb_t_killed"), unique("comb_t_resume")]
		try {
			await withScratchDb((dev) =>
				withScratchDb(async (url) => {
					const left = await killedHard(dev, url, { made, resume })
					expect((await check(dev, url)).refused).toBeUndefined()
					expect([await holds(left), await roleOf(made)]).toEqual([false, []])
				}),
			)
		} finally {
			await dropRoles(made)
		}
	}, 60_000)

	it("by SIGKILL is swept by an apply, whose CREATE ROLE of its role then passes", async () => {
		const [made, resume] = [unique("comb_t_killed"), unique("comb_t_resume")]
		try {
			await withScratchDb((dev) =>
				withScratchDb(async (url) => {
					const left = await killedHard(dev, url, { made, resume })
					write([`${UNSAFE}CREATE ROLE ${made};\n`])
					await withScratchDb((target) => applyWithAtlas(options(dev, target)))
					expect(await holds(left)).toBe(false)
				}),
			)
		} finally {
			await dropRoles(made)
		}
	}, 60_000)
})

describe("a sweep beside a live replay and a database someone is in", () => {
	it("leaves a live replay's database and role, which then passes", async () => {
		const [made, resume] = [unique("comb_t_live"), unique("comb_t_resume")]
		try {
			await withScratchDb((dev) =>
				withScratchDb(async (url) => {
					write(paused(made, resume))
					const long = check(dev, url)
					await untilRole(made)
					const live = await replayDatabases(made)
					const other = mkdtempSync(join(tmpdir(), "comb-pg-replay-sweep-b-"))
					try {
						write(["CREATE TABLE u (id int PRIMARY KEY);\n"], other)
						await applyWithAtlas({ ...options(dev, url), checkOnly: true, dir: other })
					} finally {
						rmSync(other, { force: true, recursive: true })
					}
					expect([await holds(live[0] as string), (await roleOf(made)).length]).toEqual([true, 1])
					await pause.go(resume)
					expect((await long).refused).toBeUndefined()
				}),
			)
		} finally {
			await dropRoles(made)
		}
	}, 60_000)

	it("skips a stale replay database with a session in it, keeps the verdict, and the next run takes it", async () => {
		/* pid 1 is no backend, so the replay that made it is over */
		const stale = `comb_replay_1_1_${unique("busy").slice(-8)}`
		await query(pgUrl(), `CREATE DATABASE ${stale}`)
		const session = new pg.Client({
			connectionString: Object.assign(new URL(pgUrl()), { pathname: `/${stale}` }).toString(),
		})
		try {
			await session.connect()
			await withScratchDb((dev) =>
				withScratchDb(async (url) => {
					write(["CREATE TABLE t (id int PRIMARY KEY);\n"])
					expect((await check(dev, url)).refused).toBeUndefined()
					expect(await holds(stale)).toBe(true)
					await session.end()
					expect((await check(dev, url)).refused).toBeUndefined()
					expect(await holds(stale)).toBe(false)
				}),
			)
		} finally {
			await session.end().catch(() => undefined)
			await query(pgUrl(), `DROP DATABASE IF EXISTS ${stale}`)
		}
	}, 60_000)
})

describe("a history's role the replay makes", () => {
	it("cannot log in during the check, whatever the history says, and check names it once", async () => {
		const [ops, resume] = [unique("comb_t_ops"), unique("comb_t_resume")]
		try {
			await withScratchDb((dev) =>
				withScratchDb(async (url) => {
					write(paused(ops, resume, `CREATE ROLE ${ops} LOGIN SUPERUSER PASSWORD 'comb';`))
					const running = check(dev, url)
					await untilRole(ops)
					const login = new pg.Client({
						connectionString: Object.assign(new URL(pgUrl()), { password: "comb", username: ops }).toString(),
					})
					await expect(login.connect()).rejects.toThrow(/is not permitted to log in|password authentication failed/)
					expect(await query(pgUrl(), `SELECT rolcanlogin, rolsuper FROM pg_roles WHERE rolname = '${ops}'`)).toEqual([
						{ rolcanlogin: false, rolsuper: false },
					])
					await pause.go(resume)
					const { out, refused } = await running
					expect(refused).toBeUndefined()
					expect(out.filter((line) => line.startsWith("Check made the role") && line.includes(ops))).toEqual([
						`Check made the role of "CREATE ROLE ${ops} LOGIN SUPERUSER PASSWORD 'comb'" in 20260101000000_f0.sql NOLOGIN NOSUPERUSER NOREPLICATION NOBYPASSRLS, in no role the replay did not make, on devUrl: the replay needs only its name, so apply alone gives it the rest`,
					])
				}),
			)
		} finally {
			await dropRoles(ops)
		}
	}, 60_000)
})
