/**
 * P2, P3 and P4 of r21: what a dev replay leaves on devUrl's server, here the target's too, as many
 * setups share one. A check killed by SIGINT or SIGTERM cleans up first, once, and ends as the signal
 * would; one killed past that is swept by the next check or apply at once, so apply's CREATE ROLE of
 * the role it made passes, while a live replay's database and role are never swept, nor a database
 * someone is in. The replay makes a role with no login or superuser, whatever the history says.
 */
import { spawn } from "node:child_process"
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

/* the replay's statement a test leaves running, as a seed or an index build on seeded data runs for minutes */
const SLEEP = "SELECT pg_sleep(60)"

/** The backends on the server running SLEEP */
const sleeping = async (): Promise<unknown[]> =>
	query(pgUrl(), `SELECT pid FROM pg_stat_activity WHERE query LIKE '%${SLEEP}%' AND pid <> pg_backend_pid()`)

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

/* P4 of r22: a SIGKILL left the replay's statement running, which held its database and its role until it ended */
describe("a check killed by SIGKILL mid-statement (P4 of r22)", () => {
	it("leaves nothing that stops the next apply's CREATE ROLE of its role, which passes at once", async () => {
		const made = unique("comb_t_orphan")
		try {
			await withScratchDb((dev) =>
				withScratchDb(async (url) => {
					write([
						`${UNSAFE}CREATE ROLE ${made};\nCREATE TABLE t (id int PRIMARY KEY);\nGRANT SELECT ON t TO ${made};\n`,
						`${UNSAFE}${SLEEP};\n`,
					])
					const child = childCheck(dev, url)
					await untilSleeping(child.ended)
					await child.kill("SIGKILL")
					expect((await child.ended).at(-1)).toBe("exit 137")
					/* the apply's own history alone: the sleep file stays out of it */
					for (const name of readdirSync(dir)) rmSync(join(dir, name))
					write([`${UNSAFE}CREATE ROLE ${made};\n`])
					const started = Date.now()
					await withScratchDb((target) => applyWithAtlas(options(dev, target)))
					expect([await replayDatabases(made), await sleeping()]).toEqual([[], []])
					/* at once: the statement the killed check left ended with it, and the sweep waits on nothing */
					expect(Date.now() - started).toBeLessThan(20_000)
				}),
			)
		} finally {
			await query(
				pgUrl(),
				`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query LIKE '%${SLEEP}%' AND pid <> pg_backend_pid()`,
			)
			await dropRoles(made)
		}
	}, 60_000)
})

/* PR7 of r22b: apply connected to devUrl's server before every apply, waiting 30 s on one the deploy cannot reach */
describe("an apply whose devUrl does not answer (PR7 of r22b)", () => {
	it("opens no devUrl connection when the target's server holds nothing a replay left", async () => {
		const accepted: Socket[] = []
		const silent = createServer((socket) => void accepted.push(socket))
		await new Promise<void>((done) => silent.listen(0, "127.0.0.1", done))
		const { port } = silent.address() as AddressInfo
		try {
			write([`${UNSAFE}CREATE TABLE t (id int PRIMARY KEY);\n`])
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
	it("drops that replay's database and role, so apply's CREATE ROLE of it passes", async () => {
		const [made, other] = [unique("comb_t_left"), unique("comb_t_ci")]
		/* pid 1 is no backend, so the replay that made it is over */
		const left = `comb_replay_1_1_${unique("pr8").slice(-8)}`
		try {
			await query(pgUrl(), `CREATE ROLE ${other} CREATEDB`)
			await query(pgUrl(), `CREATE DATABASE ${left} OWNER ${other}`)
			await query(pgUrl(), `CREATE ROLE ${made} NOLOGIN`)
			await query(pgUrl(), `COMMENT ON ROLE ${made} IS 'comb_replay 1_1'`)
			await query(pgUrl(), `GRANT CONNECT ON DATABASE ${left} TO ${made}`)
			write([`${UNSAFE}CREATE ROLE ${made};\n`])
			await withScratchDb((dev) => withScratchDb((target) => applyWithAtlas(options(dev, target))))
			/* the role there now is apply's own, made as the file says: the sweep dropped the replay's tagged one first */
			const tag = `SELECT shobj_description(oid, 'pg_authid') AS tag FROM pg_roles WHERE rolname = '${made}'`
			expect([await holds(left), await query(pgUrl(), tag)]).toEqual([false, [{ tag: null }]])
		} finally {
			await query(pgUrl(), `DROP DATABASE IF EXISTS ${left}`)
			await dropRoles(made, other)
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
		/* a person's psql, by its application_name, as P4 of r22 ends only a replay's own backends */
		const session = new pg.Client({
			application_name: "psql",
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

describe("two live replays under one role (P4 of r22)", () => {
	it("leaves two live replays under one role each other's, and a third check's sweep leaves both, which then pass", async () => {
		const [a, b] = [unique("comb_t_live_a"), unique("comb_t_live_b")]
		const [resumeA, resumeB] = [unique("comb_t_resume_a"), unique("comb_t_resume_b")]
		const [dirB, dirC] = [
			mkdtempSync(join(tmpdir(), "comb-pg-replay-sweep-b-")),
			mkdtempSync(join(tmpdir(), "comb-pg-replay-sweep-c-")),
		]
		try {
			await withScratchDb((dev) =>
				withScratchDb(async (url) => {
					write(paused(a, resumeA))
					write(paused(b, resumeB), dirB)
					write(["CREATE TABLE u (id int PRIMARY KEY);\n"], dirC)
					/* A pauses mid-replay; B's sweep runs beside it, then B pauses; C's sweep runs beside both */
					const first = check(dev, url)
					await untilRole(a)
					const second = check(dev, url, dirB)
					await untilRole(b)
					expect(await (await check(dev, url, dirC)).refused).toBeUndefined()
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
			await dropRoles(a, b)
		}
	}, 90_000)
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
