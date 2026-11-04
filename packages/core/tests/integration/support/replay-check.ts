/**
 * A dev replay's check run in a child process, for the suites that signal it mid-replay (P2 of r21),
 * and what they read of the server around it: the role it made, the replay databases that hold it,
 * and their drop as a test's own cleanup.
 */
import { spawn } from "node:child_process"
import { join } from "node:path"
import { pgUrl } from "./pg.ts"
import { dropRoles as dropOnly, query, roleOf } from "./pg-roles.ts"

/** Until the server holds `role`, at most 30 s */
export async function untilRole(role: string): Promise<void> {
	for (let tries = 0; (await roleOf(role)).length === 0; tries++) {
		if (tries > 600) throw new Error(`the replay never made ${role}`)
		await new Promise((done) => setTimeout(done, 50))
	}
}

/** The replay databases on the server that hold `role` by a grant, as a replay holds each role it made */
export const replayDatabases = async (role: string): Promise<string[]> =>
	(
		await query(
			pgUrl(),
			`SELECT datname FROM pg_database WHERE datname LIKE 'comb\\_replay\\_%' AND datacl::text LIKE '%${role}=%'`,
		)
	).map((row) => String(row["datname"]))

/**
 * A check of the directory in a child process, under a shell that says how it ended, as a terminal
 * or a CI runner reads it; `kill` sends the child a signal, and `ended` is all it wrote, its end last
 */
export function childCheck(devUrl: string, url: string, dir: string) {
	const child = spawn(
		"sh",
		[
			"-c",
			'bun "$0" "$1"; echo "exit $?"',
			join(import.meta.dirname, "replay-child.ts"),
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
	/* the check's pid once it wrote it, and its shell's */
	const pids = (): number[] => [child.pid ?? 0, Number(/^pid (\d+)$/m.exec(said)?.[1] ?? 0)]
	const hardKill = (): void => {
		for (const each of pids().toReversed()) if (each > 0) process.kill(each, "SIGKILL")
	}
	return { ended, hardKill, kill: async (signal: NodeJS.Signals) => process.kill(await pid(), signal), pids }
}

/* how long a signalled check may take to end, well under the case's timeout, before the case kills it and fails */
const ENDS_WITHIN_MS = 30_000

/** What `child` wrote by its end, or, past ENDS_WITHIN_MS, it and its shell SIGKILLed and the case failed with their pids */
export async function endedWithin(child: ReturnType<typeof childCheck>): Promise<string[]> {
	let timer: NodeJS.Timeout | undefined
	const late = new Promise<never>((_, fail) => {
		timer = setTimeout(() => {
			child.hardKill()
			fail(
				new Error(
					`the check (pid ${child.pids().join(", ")}) had not ended ${ENDS_WITHIN_MS} ms after its signal: SIGKILLed`,
				),
			)
		}, ENDS_WITHIN_MS)
	})
	try {
		return await Promise.race([child.ended, late])
	} finally {
		clearTimeout(timer)
	}
}

/**
 * `roles` dropped, with any replay database a failed run left that grants one of them CONNECT, which
 * holds it. A replay's role that its cleanup left is stale to every other check in the run, whose
 * sweep may drop it first: two sessions dropping one role race in Postgres's catalog, and the loser
 * fails (XX000, "could not find tuple for role"), so a role gone after a failed drop is dropped
 */
export async function dropRoles(...roles: string[]): Promise<void> {
	const held = await query(
		pgUrl(),
		`SELECT datname FROM pg_database WHERE datname LIKE 'comb\\_replay\\_%' AND (${roles.map((role) => `datacl::text LIKE '%${role}=%'`).join(" OR ")})`,
	)
	for (const { datname } of held) await query(pgUrl(), `DROP DATABASE IF EXISTS ${String(datname)} WITH (FORCE)`)
	for (const role of roles) {
		try {
			await dropOnly(role)
		} catch (error) {
			if ((await roleOf(role)).length > 0) throw error
		}
	}
}
