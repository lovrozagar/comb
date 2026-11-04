/**
 * A signal delivered to the test's own process as Node delivers it, with only comb listening, and
 * process.kill stubbed so the end comb asks for is read rather than done (S2, KC5 and PA4 of r22)
 */
import { afterEach, beforeEach, type MockInstance, vi } from "vitest"

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

/* process.kill as the OS answers it, bound before any test stubs it */
const realKill = process.kill.bind(process)

/** Whether process `pid` runs, read past a stubbed process.kill */
export function alive(pid: number): boolean {
	try {
		realKill(pid, 0)
		return true
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM"
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
