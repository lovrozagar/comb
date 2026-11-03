import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import { onceCleanup, onSignals } from "./cleanup.ts"

describe("onceCleanup", () => {
	it("cleans nothing until a step is set, then runs that step once however often it is asked", async () => {
		const step = vi.fn(async () => undefined)
		const cleanup = onceCleanup()
		await cleanup.run()
		cleanup.set(step)
		await Promise.all([cleanup.run(), cleanup.run()])
		await cleanup.run()
		expect(step).toHaveBeenCalledTimes(1)
	})

	it("runs a step set after a run, as a signal before there is anything to clean leaves it to run", async () => {
		const cleanup = onceCleanup()
		await cleanup.run()
		const step = vi.fn(async () => undefined)
		cleanup.set(step)
		await cleanup.run()
		expect(step).toHaveBeenCalledTimes(1)
	})
})

describe("onSignals", () => {
	it("returns the body's value and leaves no listener behind", async () => {
		const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]
		expect(
			await onSignals(
				async () => undefined,
				async () => 7,
			),
		).toBe(7)
		expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before)
	})

	it("leaves no listener behind when the body throws", async () => {
		const before = process.listenerCount("SIGTERM")
		await expect(
			onSignals(
				async () => undefined,
				async () => {
					throw new Error("body")
				},
			),
		).rejects.toThrow("body")
		expect(process.listenerCount("SIGTERM")).toBe(before)
	})
})

describe("onSignals on a signal", () => {
	const kill = vi.spyOn(process, "kill").mockImplementation(() => true)
	afterEach(() => kill.mockClear())
	afterAll(() => kill.mockRestore())

	it.each([["SIGINT"], ["SIGTERM"]] as const)("on %s cleans up, then ends the process by it again", async (signal) => {
		const saved = process.listeners(signal)
		process.removeAllListeners(signal)
		try {
			let cleaned!: () => void
			const done = new Promise<void>((resolve) => (cleaned = resolve))
			await onSignals(
				async () => cleaned(),
				async () => {
					process.emit(signal, signal)
					await done
				},
			)
			await new Promise((resolve) => setImmediate(resolve))
			expect(kill.mock.calls).toEqual([[process.pid, signal]])
		} finally {
			for (const listener of saved) process.on(signal, listener)
		}
	})

	it("leaves the end to a host that listens for the signal itself", async () => {
		const host = vi.fn()
		process.on("SIGTERM", host)
		try {
			const cleanup = vi.fn(async () => undefined)
			await onSignals(cleanup, async () => {
				process.emit("SIGTERM", "SIGTERM")
				await new Promise((resolve) => setImmediate(resolve))
			})
			expect([cleanup.mock.calls.length, host.mock.calls.length, kill.mock.calls]).toEqual([1, 1, []])
		} finally {
			process.off("SIGTERM", host)
		}
	})
})
