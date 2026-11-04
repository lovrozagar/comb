/**
 * A run's window, in a process of its own (tests/integration/postgres/run-lock.test.ts): it runs the
 * global setup at argv's `setup` once for each of `projects`, as vitest runs it for each project
 * that names it, appends `start <name>` to `log`, waits for `peer`'s start for up to `hold` ms (or
 * for good, with `hold` 0, until a test kills it), appends `end <name>`, tears the setup down, and
 * appends `exit <name>` once the peer started or 10 s passed. The log's order is the windows': a
 * peer that starts between a start and its end ran beside it.
 */
import { appendFileSync, readFileSync } from "node:fs"

type Window = { hold: number; log: string; name: string; peer: string; projects: number; setup: string }

const { hold, log, name, peer, projects, setup } = JSON.parse(process.argv[2] as string) as Window

/** Whether `name`'s start is in the log */
const started = (who: string): boolean => readFileSync(log, "utf8").split("\n").includes(`start ${who}`)

/** Until `peer` started, or `ms` passed (0: for good) */
async function awaitPeer(ms: number): Promise<void> {
	const until = ms === 0 ? Number.POSITIVE_INFINITY : Date.now() + ms
	while (!started(peer) && Date.now() < until) await new Promise((done) => setTimeout(done, 20))
}

const { default: run } = (await import(setup)) as { default: () => unknown }
const teardowns: unknown[] = []
for (let project = 0; project < projects; project += 1) teardowns.push(await run())
appendFileSync(log, `start ${name}\n`)
await awaitPeer(hold)
appendFileSync(log, `end ${name}\n`)
for (const teardown of teardowns.toReversed()) if (typeof teardown === "function") await teardown()
await awaitPeer(10_000)
appendFileSync(log, `exit ${name}\n`)
process.exit(0)
