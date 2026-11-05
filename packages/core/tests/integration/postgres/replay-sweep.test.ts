/**
 * P2, P3 and P4 of r21: what a dev replay leaves on devUrl's server, here the target's too, as many
 * setups share one. A check killed by SIGINT or SIGTERM cleans up first, once, and ends as the signal
 * would; one killed past that is swept by the next check or apply at once, so apply's CREATE ROLE of
 * the role it made passes, while a live replay's database and role are never swept, nor a database
 * someone is in. The replay makes a role with no login or superuser, whatever the history says.
 */
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { type AddressInfo, createServer, type Socket } from "node:net"
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
import { childCheck, replayDatabases, untilRole } from "../support/replay-check.ts"
import { query, roleOf, testRoles, unique } from "../support/pg-roles.ts"
import { leavesStale, needsNothingStale } from "../support/stale-replay.ts"

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
async function write(files: readonly string[], at = dir): Promise<void> {
	files.forEach((sql, i) => writeFileSync(join(at, `20260101${String(i).padStart(6, "0")}_f${i}.sql`), sql))
	await hashDir(run, at)
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

/** A check of the directory, or of `at`, against `url`: what it printed, and why it refused */
async function check(devUrl: string, url: string, at = dir): Promise<{ out: string[]; refused?: string | undefined }> {
	const out: string[] = []
	try {
		await applyWithAtlas({ ...options(devUrl, url, out), checkOnly: true, dir: at })
		return { out }
	} catch (error) {
		return { out, refused: (error as Error).message }
	}
}

/** Whether the server holds the database `name` */
const holds = async (name: string): Promise<boolean> =>
	(await query(pgUrl(), `SELECT 1 FROM pg_database WHERE datname = '${name}'`)).length > 0

/**
 * A stale replay's database `name` (pid 1 is no backend, so its replay is over), made a template, which no
 * sweep may drop: every other file's apply and check sweeps this server, and took a plain one, or its
 * tagged role, while the test still set it up ("tuple concurrently deleted" in a GRANT on it)
 */
const plantHeld = (name: string, clause = ""): Promise<unknown> =>
	query(pgUrl(), `CREATE DATABASE ${name} ${clause} IS_TEMPLATE true`)

/** `name`, planted held, handed to any sweep; a template no sweep could drop, so only one still held */
async function release(name: string): Promise<void> {
	const held = await query(pgUrl(), `SELECT 1 FROM pg_database WHERE datname = '${name}' AND datistemplate`)
	if (held.length > 0) await query(pgUrl(), `ALTER DATABASE ${name} IS_TEMPLATE false`)
}

/**
 * A check of `made`'s paused history killed by SIGKILL mid-replay, past any cleanup, its statement in
 * flight then let end, as a killed check's does: the replay database it left, holding `made`
 */
async function killedHard(
	dev: string,
	url: string,
	{ made, resume }: { made: string; resume: string },
): Promise<string> {
	await write(paused(made, resume))
	const child = childCheck(dev, url, dir)
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
			const [made] = testRoles("comb_t_killed")
			const resume = unique("comb_t_resume")
			await withScratchDb((dev) =>
				withScratchDb(async (url) => {
					await write(paused(made, resume))
					const child = childCheck(dev, url, dir)
					await untilRole(made)
					await child.kill(signal)
					const said = await child.ended
					expect(said.at(-1)).toBe(`exit ${code}`)
					expect(said.filter((line) => line.startsWith("drop "))).toHaveLength(1)
					expect(await roleOf(made)).toEqual([])
					expect(await replayDatabases(made)).toEqual([])
				}),
			)
		},
		60_000,
	)
})

describe("a check killed by SIGKILL mid-replay", () => {
	leavesStale()

	it("is swept by the next check at once", async () => {
		const [made] = testRoles("comb_t_killed")
		const resume = unique("comb_t_resume")
		await withScratchDb((dev) =>
			withScratchDb(async (url) => {
				const left = await killedHard(dev, url, { made, resume })
				expect((await check(dev, url)).refused).toBeUndefined()
				expect([await holds(left), await roleOf(made)]).toEqual([false, []])
			}),
		)
	}, 60_000)

	it("is swept by an apply, whose CREATE ROLE of its role then passes", async () => {
		const [made] = testRoles("comb_t_killed")
		const resume = unique("comb_t_resume")
		await withScratchDb((dev) =>
			withScratchDb(async (url) => {
				const left = await killedHard(dev, url, { made, resume })
				await write([`${UNSAFE}CREATE ROLE ${made};\n`])
				await withScratchDb((target) => applyWithAtlas(options(dev, target)))
				expect(await holds(left)).toBe(false)
			}),
		)
	}, 60_000)
})

/* the replay's statement a test leaves running, as a seed or an index build on seeded data runs for minutes */
const SLEEP = "SELECT pg_sleep(120)"

/* half the sleep: what a check's statement or an apply takes here only by waiting the sleep out, under any load */
const HALF_SLEEP_MS = 60_000

/** The backends on the server running SLEEP, each by its pid and state */
const sleeping = async (): Promise<unknown[]> =>
	query(pgUrl(), `SELECT pid, state FROM pg_stat_activity WHERE query LIKE '%${SLEEP}%' AND pid <> pg_backend_pid()`)

/** Until a backend runs SLEEP, at most 60 s; a check that `ended` first fails with what it wrote */
async function untilSleeping(ended: Promise<string[]>): Promise<void> {
	let gone: string[] | undefined
	void ended.then((said) => (gone = said))
	const deadline = Date.now() + 60_000
	while ((await sleeping()).length === 0) {
		if (gone !== undefined) throw new Error(`the check ended before its sleep: ${gone.join("\n")}`)
		if (Date.now() > deadline) throw new Error("the replay never ran its sleep")
		await new Promise((done) => setTimeout(done, 100))
	}
}

/**
 * Until no backend runs SLEEP, at most half of it, else fails naming each that does: the statement
 * the kill left running, which only ends by waiting the sleep out
 */
async function untilAwake(): Promise<void> {
	const deadline = Date.now() + HALF_SLEEP_MS
	for (let left = await sleeping(); left.length > 0; left = await sleeping()) {
		if (Date.now() > deadline)
			throw new Error(`the killed check's statement ran on past half its sleep: ${JSON.stringify(left)}`)
		await new Promise((done) => setTimeout(done, 100))
	}
}

/*
 * P4 of r22: a SIGKILL left the replay's statement running, which held its database and its role
 * until it ended. The mechanism, not the clock: the statement ends with its client, so none runs at
 * the apply's start, and the apply takes under half the sleep, which only waiting it out exceeds.
 */
describe("a check killed by SIGKILL mid-statement (P4 of r22)", () => {
	leavesStale()
	it(
		"leaves nothing that stops the next apply's CREATE ROLE of its role, which passes at once",
		async () => {
			const [made] = testRoles("comb_t_orphan")
			try {
				await withScratchDb((dev) =>
					withScratchDb(async (url) => {
						await write([
							`${UNSAFE}CREATE ROLE ${made};\nCREATE TABLE t (id int PRIMARY KEY);\nGRANT SELECT ON t TO ${made};\n`,
							`${UNSAFE}${SLEEP};\n`,
						])
						const child = childCheck(dev, url, dir)
						await untilSleeping(child.ended)
						await child.kill("SIGKILL")
						expect((await child.ended).at(-1)).toBe("exit 137")
						await untilAwake()
						/* the apply's own history alone: the sleep file stays out of it */
						for (const name of readdirSync(dir)) rmSync(join(dir, name))
						await write([`${UNSAFE}CREATE ROLE ${made};\n`])
						expect(await sleeping()).toEqual([])
						const started = Date.now()
						await withScratchDb((target) => applyWithAtlas(options(dev, target)))
						expect(Date.now() - started).toBeLessThan(HALF_SLEEP_MS)
						expect([await replayDatabases(made), await sleeping()]).toEqual([[], []])
					}),
				)
			} finally {
				await query(
					pgUrl(),
					`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query LIKE '%${SLEEP}%' AND pid <> pg_backend_pid()`,
				)
			}
		},
		3 * HALF_SLEEP_MS,
	)
})

/* PR7 of r22b: apply connected to devUrl's server before every apply, waiting 30 s on one the deploy cannot reach */
describe("an apply whose devUrl does not answer (PR7 of r22b)", () => {
	needsNothingStale()
	it("opens no devUrl connection when the target's server holds nothing a replay left", async () => {
		const accepted: Socket[] = []
		const silent = createServer((socket) => void accepted.push(socket))
		await new Promise<void>((done) => silent.listen(0, "127.0.0.1", done))
		const { port } = silent.address() as AddressInfo
		try {
			await write([`${UNSAFE}CREATE TABLE t (id int PRIMARY KEY);\n`])
			const out: string[] = []
			await withScratchDb((url) =>
				applyWithAtlas(options(`postgres://nobody:x@127.0.0.1:${port}/dev?sslmode=disable`, url, out)),
			)
			expect(out).toContain("Apply: 20260101000000_f0.sql")
			expect(accepted).toHaveLength(0)
		} finally {
			for (const socket of accepted) socket.destroy()
			await new Promise((done) => silent.close(done))
		}
	}, 60_000)
})

/* PR8 of r22b: the sweep dropped only its own role's databases, so another devUrl role's leftover held its role */
describe("a superuser's sweep of a replay another role left (PR8 of r22b)", () => {
	leavesStale()
	it("drops that replay's database and role, so apply's CREATE ROLE of it passes", async () => {
		const [made, other] = testRoles("comb_t_left", "comb_t_ci")
		/* pid 1 is no backend, so the replay that made it is over */
		const left = `comb_replay_1_1_${unique("pr8").slice(-8)}`
		try {
			await query(pgUrl(), `CREATE ROLE ${other} CREATEDB`)
			await plantHeld(left, `OWNER ${other}`)
			await query(pgUrl(), `CREATE ROLE ${made} NOLOGIN`)
			await query(pgUrl(), `GRANT CONNECT ON DATABASE ${left} TO ${made}`)
			/* the tag last, as it makes the role a sweep's, and then the database */
			await query(pgUrl(), `COMMENT ON ROLE ${made} IS 'comb_replay 1_1'`)
			await release(left)
			await write([`${UNSAFE}CREATE ROLE ${made};\n`])
			await withScratchDb((dev) => withScratchDb((target) => applyWithAtlas(options(dev, target))))
			/* the role there now is apply's own, made as the file says: the sweep dropped the replay's tagged one first */
			const tag = `SELECT shobj_description(oid, 'pg_authid') AS tag FROM pg_roles WHERE rolname = '${made}'`
			expect([await holds(left), await query(pgUrl(), tag)]).toEqual([false, [{ tag: null }]])
		} finally {
			await release(left)
			await query(pgUrl(), `DROP DATABASE IF EXISTS ${left}`)
		}
	}, 60_000)
})

describe("a sweep beside a live replay and a database someone is in", () => {
	leavesStale()
	it("leaves a live replay's database and role, which then passes", async () => {
		const [made] = testRoles("comb_t_live")
		const resume = unique("comb_t_resume")
		await withScratchDb((dev) =>
			withScratchDb(async (url) => {
				await write(paused(made, resume))
				const long = check(dev, url)
				await untilRole(made)
				const live = await replayDatabases(made)
				const other = mkdtempSync(join(tmpdir(), "comb-pg-replay-sweep-b-"))
				try {
					await write(["CREATE TABLE u (id int PRIMARY KEY);\n"], other)
					await applyWithAtlas({ ...options(dev, url), checkOnly: true, dir: other })
				} finally {
					rmSync(other, { force: true, recursive: true })
				}
				expect([await holds(live[0] as string), (await roleOf(made)).length]).toEqual([true, 1])
				await pause.go(resume)
				expect((await long).refused).toBeUndefined()
			}),
		)
	}, 60_000)

	it("skips a stale replay database with a session in it, keeps the verdict, and the next run takes it", async () => {
		/* pid 1 is no backend, so the replay that made it is over */
		const stale = `comb_replay_1_1_${unique("busy").slice(-8)}`
		await plantHeld(stale)
		/* a person's psql, by its application_name, as P4 of r22 ends only a replay's own backends */
		const session = new pg.Client({
			application_name: "psql",
			connectionString: Object.assign(new URL(pgUrl()), { pathname: `/${stale}` }).toString(),
		})
		try {
			await session.connect()
			await release(stale)
			await withScratchDb((dev) =>
				withScratchDb(async (url) => {
					await write(["CREATE TABLE t (id int PRIMARY KEY);\n"])
					expect((await check(dev, url)).refused).toBeUndefined()
					expect(await holds(stale)).toBe(true)
					await session.end()
					expect((await check(dev, url)).refused).toBeUndefined()
					expect(await holds(stale)).toBe(false)
				}),
			)
		} finally {
			await session.end().catch(() => undefined)
			await release(stale)
			await query(pgUrl(), `DROP DATABASE IF EXISTS ${stale}`)
		}
	}, 60_000)
})

describe("two live replays under one role (P4 of r22)", () => {
	it("leaves two live replays under one role each other's, and a third check's sweep leaves both, which then pass", async () => {
		const [a, b] = testRoles("comb_t_live_a", "comb_t_live_b")
		const [resumeA, resumeB] = [unique("comb_t_resume_a"), unique("comb_t_resume_b")]
		const [dirB, dirC] = [
			mkdtempSync(join(tmpdir(), "comb-pg-replay-sweep-b-")),
			mkdtempSync(join(tmpdir(), "comb-pg-replay-sweep-c-")),
		]
		try {
			await withScratchDb((dev) =>
				withScratchDb(async (url) => {
					await write(paused(a, resumeA))
					await write(paused(b, resumeB), dirB)
					await write(["CREATE TABLE u (id int PRIMARY KEY);\n"], dirC)
					/* A pauses mid-replay; B's sweep runs beside it, then B pauses; C's sweep runs beside both */
					const first = check(dev, url)
					await untilRole(a)
					const second = check(dev, url, dirB)
					await untilRole(b)
					expect((await check(dev, url, dirC)).refused).toBeUndefined()
					const live = [...(await replayDatabases(a)), ...(await replayDatabases(b))]
					expect(live).toHaveLength(2)
					expect(await Promise.all(live.map(holds))).toEqual([true, true])
					expect([(await roleOf(a)).length, (await roleOf(b)).length]).toEqual([1, 1])
					await pause.go(resumeA)
					await pause.go(resumeB)
					/* a backend a sweep ended would fail its check */
					expect((await Promise.all([first, second])).map((each) => each.refused)).toEqual([undefined, undefined])
				}),
			)
		} finally {
			for (const at of [dirB, dirC]) rmSync(at, { force: true, recursive: true })
		}
	}, 90_000)
})

describe("a history's role the replay makes", () => {
	it("cannot log in during the check, whatever the history says, and check names it once", async () => {
		const [ops] = testRoles("comb_t_ops")
		const resume = unique("comb_t_resume")
		await withScratchDb((dev) =>
			withScratchDb(async (url) => {
				await write(paused(ops, resume, `CREATE ROLE ${ops} LOGIN SUPERUSER PASSWORD 'comb';`))
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
	}, 60_000)
})
