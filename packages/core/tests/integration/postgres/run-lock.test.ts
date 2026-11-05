/**
 * One Postgres run at a time on the shared test server (comb-9d, plan 21): two processes that run
 * Postgres suites on one COMB_TEST_PG_URL serialize on the server itself, however each was started.
 * Each window is a child process running the global setup vitest.config.ts gives the project of a
 * Postgres suite (tests/integration/support/run-window.ts), on a scratch database, so the run this
 * test is in, holding the lock on its own database, never meets them.
 */
import { spawn } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, matchesGlob } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import config from "../../../vitest.config.ts"
import { withScratchDb } from "../support/pg.ts"

const CORE = join(import.meta.dirname, "../../..")

/** The global setup of the UTC project that runs `file`, as vitest.config.ts says */
function setupOf(file: string): string {
	const projects = (config.test?.projects ?? []) as Array<{
		test: { env?: object; exclude?: string[]; globalSetup?: string[]; include?: string[] }
	}>
	const owner = projects.find(
		({ test }) =>
			test.env === undefined &&
			(test.include ?? []).some((glob) => matchesGlob(file, glob)) &&
			!(test.exclude ?? []).some((glob) => matchesGlob(file, glob)),
	)
	return join(CORE, owner?.test.globalSetup?.[0] as string)
}

let dir = ""
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "comb-run-lock-"))
	writeFileSync(join(dir, "log"), "")
})
afterEach(() => rmSync(dir, { force: true, recursive: true }))

/** A run's window, as run-window.ts takes it, but for the log and the setup */
type Window = { hold: number; name: string; peer: string; projects: number; settle?: number }

/** A run's window in a child on the server at `url`: its stderr, how it ended, and a kill */
function window(url: string, { hold, name, peer, projects, settle = 0 }: Window) {
	const setup = setupOf("tests/integration/postgres/keyset.test.ts")
	const child = spawn(
		"bun",
		[
			join(import.meta.dirname, "../support/run-window.ts"),
			JSON.stringify({ hold, log: join(dir, "log"), name, peer, projects, settle, setup }),
		],
		{ env: { ...process.env, COMB_TEST_PG_URL: url }, stdio: ["ignore", "ignore", "pipe"] },
	)
	let said = ""
	child.stderr.on("data", (chunk: Buffer) => {
		said += chunk.toString()
	})
	const ended = new Promise<number | null>((done) => child.on("close", (code) => done(code)))
	return { ended, kill: () => child.kill("SIGKILL"), said: () => said }
}

/** The log's lines */
const lines = (): string[] => readFileSync(join(dir, "log"), "utf8").trim().split("\n")

/** Until `test` holds */
async function until(test: () => boolean): Promise<void> {
	while (!test()) await new Promise((done) => setTimeout(done, 20))
}

const WAITING = /^\[comb\] waiting for another run's Postgres suites on .+: advisory lock \(.+\)$/

/** How many lines of `said` say the run waits on the lock */
const waits = (said: string): number => said.split("\n").filter((line) => WAITING.test(line)).length

describe("two runs of the Postgres suites on one server", () => {
	it.each([1, 2])(
		"run one after the other, each window closed before the next opens, with the setup run for %i project(s)",
		async (projects) => {
			await withScratchDb(async (url) => {
				const runs = [
					window(url, { hold: 3000, name: "a", peer: "b", projects }),
					window(url, { hold: 3000, name: "b", peer: "a", projects }),
				]
				expect(await Promise.all(runs.map((run) => run.ended))).toEqual([0, 0])
				const order = lines()
				const windows = order.filter((line) => !line.startsWith("exit "))
				const [first, second] = [windows[0]?.split(" ")[1], windows[2]?.split(" ")[1]]
				expect(windows).toEqual([`start ${first}`, `end ${first}`, `start ${second}`, `end ${second}`])
				/* the first run's teardown let the second in while it still ran */
				expect(order.indexOf(`start ${second}`)).toBeLessThan(order.indexOf(`exit ${first}`))
				expect(runs.map((run) => waits(run.said())).toSorted()).toEqual([0, 1])
			})
		},
		60_000,
	)

	/* the holder's teardown lets the waiter in however long the waiter then takes to open its window */
	it("lets the second in at the first's teardown, the first still running until the second opens", async () => {
		await withScratchDb(async (url) => {
			const first = window(url, { hold: 3000, name: "a", peer: "b", projects: 1 })
			await until(() => lines().includes("start a"))
			const second = window(url, { hold: 3000, name: "b", peer: "a", projects: 1, settle: 10_500 })
			expect(await Promise.all([first.ended, second.ended])).toEqual([0, 0])
			expect(lines()).toEqual(["start a", "end a", "start b", "exit a", "end b", "exit b"])
		})
	}, 60_000)

	it("lets the waiting run in once the holding run's process is killed, Postgres freeing the lock with its session", async () => {
		await withScratchDb(async (url) => {
			const holder = window(url, { hold: 0, name: "a", peer: "never", projects: 1 })
			await until(() => lines().includes("start a"))
			const waiter = window(url, { hold: 3000, name: "b", peer: "a", projects: 1 })
			await until(() => waits(waiter.said()) > 0)
			expect(lines()).toEqual(["start a"])
			holder.kill()
			expect(await waiter.ended).toBe(0)
			expect(lines()).toEqual(["start a", "start b", "end b", "exit b"])
			expect(waits(waiter.said())).toBe(1)
		})
	}, 60_000)
})
