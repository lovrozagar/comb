/**
 * A dev replay's check run in a child process, for the suites that signal it mid-replay (P2 of r21),
 * and what they read of the server around it: the role it made and the replay databases that hold it.
 */
import { spawn } from "node:child_process"
import { join } from "node:path"
import { type Seen, see, send } from "../../support/pid.ts"
import { pgUrl } from "./pg.ts"
import { query, roleOf } from "./pg-roles.ts"

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
 * or a CI runner reads it; `kill` sends the check a signal, and `ended` is all it wrote, its end last.
 * The check is seen as the shell's child as soon as it writes its pid, so neither signal reaches a
 * later process given its pid.
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
	let check: Seen | undefined
	child.stdout.on("data", (chunk: Buffer) => {
		said += chunk.toString()
		/* read as the line comes, while the shell, which Node has not reaped, holds the check as its child */
		check ??= see(Number(/^pid (\d+)$/m.exec(said)?.[1]), child.pid)
	})
	const ended = new Promise<string[]>((done) => child.on("close", () => done(said.trim().split("\n"))))
	const seen = async (): Promise<Seen> => {
		while (!/^pid \d+$/m.test(said)) await new Promise((done) => setTimeout(done, 20))
		if (check === undefined) throw new Error(`the check wrote a pid that is not the shell's child: ${said}`)
		return check
	}
	/* the shell's pid, and the check's once it wrote it */
	const pids = (): number[] => [child.pid ?? 0, check?.pid ?? 0]
	const hardKill = (): void => {
		if (check !== undefined) send(check, "SIGKILL")
		child.kill("SIGKILL")
	}
	const kill = async (sent: NodeJS.Signals): Promise<void> => {
		if (!send(await seen(), sent)) throw new Error(`the check ${check?.pid} had ended before ${sent}`)
	}
	return { ended, hardKill, kill, pids }
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
