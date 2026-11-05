/**
 * A signal delivered to the test's own process as Node delivers it, with only comb listening, and
 * process.kill stubbed so the end comb asks for is read rather than done (S2, KC5 and PA4 of r22)
 */
import { afterEach, beforeEach, type MockInstance, vi } from "vitest"
import { hold, pastStop } from "../../src/migrate/core/cleanup.ts"

/** One turn of the event loop, after the promise callbacks queued before it */
export const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/* the worker's own listeners, read as a test file loads this, before any test arms comb's */
export const worker = { SIGINT: process.listeners("SIGINT"), SIGTERM: process.listeners("SIGTERM") }

/** `signal` to this process with the worker's listeners off, so comb's is the only one, as in the CLI */
export async function deliver(signal: "SIGINT" | "SIGTERM"): Promise<void> {
	const others = worker[signal]
	for (const listener of others) process.off(signal, listener)
	try {
		process.emit(signal, signal)
		await settle()
	} finally {
		for (const listener of others) process.on(signal, listener)
	}
}

/** process.kill stubbed for each test of the calling describe; `calls` are the ends asked for */
export function stubKill(): { calls: () => unknown[][] } {
	let kill: MockInstance<typeof process.kill> | undefined
	beforeEach(() => {
		kill = vi.spyOn(process, "kill").mockImplementation(() => true)
	})
	afterEach(() => kill?.mockRestore())
	return { calls: () => kill?.mock.calls ?? [] }
}

/** Until `done` holds, at most 10 s, a turn of the event loop at a time */
export async function until(done: () => boolean, what: string): Promise<void> {
	for (let tries = 0; !done(); tries++) {
		if (tries > 1000) throw new Error(`never: ${what}`)
		await new Promise((resolve) => setTimeout(resolve, 10))
	}
}

/**
 * `open`, a seam that starts new work (a session, a connection, a scratch), called while a SIGTERM's
 * held step runs, a host listening so the process stays: whether it settled before the step ended,
 * which a seam that waits for the stop never does, and what it settled to once the step was let end
 */
export async function openedWhileStopping<T>(open: () => Promise<T>): Promise<{ early: boolean; value: T }> {
	const host = (): undefined => undefined
	process.on("SIGTERM", host)
	for (const listener of worker.SIGTERM) process.off("SIGTERM", listener)
	let end = (): void => undefined
	const ending = new Promise<void>((resolve) => {
		end = resolve
	})
	const release = hold(() => ending)
	try {
		process.emit("SIGTERM", "SIGTERM")
		let settled = false
		const opening = open().finally(() => {
			settled = true
		})
		await new Promise((resolve) => setTimeout(resolve, 50))
		const early = settled
		end()
		/* the stop ends with the host still listening, so it lets the process stay, before the listeners go back */
		await pastStop()
		return { early, value: await opening }
	} finally {
		end()
		release()
		process.off("SIGTERM", host)
		for (const listener of worker.SIGTERM) process.on("SIGTERM", listener)
	}
}
