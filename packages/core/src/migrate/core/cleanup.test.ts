import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { deliver, settle, stubKill, until, worker } from "../../../tests/support/signals.ts"
import {
	hold,
	pastStop,
	hostMark,
	isAlive,
	onceCleanup,
	onSignals,
	SCRATCH_STALE_MS,
	scratchDir,
	sweepScratch,
} from "./cleanup.ts"

/* a pid past any pid_max (Linux's ceiling is 2^22), so no process ever runs as it */
const DEAD = 4_194_305

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
	it("returns the body's value", async () => {
		expect(
			await onSignals(
				async () => undefined,
				async () => 7,
			),
		).toBe(7)
	})

	it("passes on what the body throws", async () => {
		await expect(
			onSignals(
				async () => undefined,
				async () => {
					throw new Error("body")
				},
			),
		).rejects.toThrow("body")
	})
})

describe("isAlive", () => {
	it("reads this process as running, a pid no process has as gone, and one another user runs as running", () => {
		/* pid 1 is init: EPERM to a user who isn't root, plainly alive to root; running either way */
		expect([isAlive(process.pid), isAlive(DEAD), isAlive(1)]).toEqual([true, false, true])
	})
})

describe("hostMark", () => {
	afterEach(() => vi.restoreAllMocks())

	it("is eight hex digits from the host and its pid namespace, and from the host alone where there is no /proc", () => {
		const mark = hostMark()
		expect(mark).toMatch(/^[0-9a-f]{8}$/)
		vi.spyOn(fs, "readlinkSync").mockImplementation(() => {
			throw Object.assign(new Error("no /proc"), { code: "ENOENT" })
		})
		const hostOnly = hostMark()
		expect(hostOnly).toMatch(/^[0-9a-f]{8}$/)
		expect(hostOnly).not.toBe(mark)
	})
})

describe("sweepScratch (S2 of r22; sibling: P2 of r21's replay sweep by owner)", () => {
	let dir: string
	const left = () => fs.readdirSync(dir).sort()
	const make = (name: string) => fs.mkdirSync(path.join(dir, name))
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-sweep-"))
	})
	afterEach(() => {
		vi.restoreAllMocks()
		fs.rmSync(dir, { force: true, recursive: true })
	})

	it("removes one a gone process of this host left at once, and keeps a live one's, another host's and one with no pid", () => {
		const mark = hostMark()
		make(`comb-scratch-${DEAD}-${mark}-gone`)
		make(`comb-scratch-${process.pid}-${mark}-live`)
		make(`comb-scratch-${DEAD}-00000000-elsewhere`)
		make("comb-scratch-nopid")
		make(`comb-codegen-${DEAD}-${mark}-other-prefix`)
		sweepScratch("comb-scratch-", dir)
		expect(left()).toEqual(
			[
				`comb-codegen-${DEAD}-${mark}-other-prefix`,
				`comb-scratch-${DEAD}-00000000-elsewhere`,
				`comb-scratch-${process.pid}-${mark}-live`,
				"comb-scratch-nopid",
			].sort(),
		)
	})

	it("removes any past the stale age, a live pid's too, since no run holds one that long", () => {
		const mark = hostMark()
		make(`comb-scratch-${process.pid}-${mark}-live`)
		make("comb-scratch-nopid")
		sweepScratch("comb-scratch-", dir, Date.now() + SCRATCH_STALE_MS - 60_000)
		expect(left()).toHaveLength(2)
		sweepScratch("comb-scratch-", dir, Date.now() + SCRATCH_STALE_MS + 60_000)
		expect(left()).toEqual([])
	})

	it("keeps another user's, and reads every one as this user's where there are no uids", () => {
		make(`comb-scratch-${DEAD}-${hostMark()}-theirs`)
		const stat = fs.statSync(path.join(dir, left()[0] as string))
		vi.spyOn(fs, "statSync").mockReturnValue({ ...stat, uid: stat.uid + 1 } as fs.Stats)
		sweepScratch("comb-scratch-", dir)
		expect(left()).toHaveLength(1)
		vi.spyOn(process, "getuid").mockReturnValue(undefined as unknown as number)
		sweepScratch("comb-scratch-", dir)
		expect(left()).toEqual([])
	})

	it("passes over one another run removed first", () => {
		make(`comb-scratch-${DEAD}-${hostMark()}-raced`)
		vi.spyOn(fs, "statSync").mockImplementation(() => {
			throw Object.assign(new Error("gone"), { code: "ENOENT" })
		})
		expect(() => sweepScratch("comb-scratch-", dir)).not.toThrow()
	})
})

describe("scratchDir", () => {
	afterEach(() => vi.restoreAllMocks())

	it("makes a 0700 directory named for this process under the temp directory, and removes it", () => {
		const scratch = scratchDir("comb-cleanup-test-")
		expect(path.dirname(scratch.dir)).toBe(os.tmpdir())
		expect(path.basename(scratch.dir)).toMatch(new RegExp(`^comb-cleanup-test-${process.pid}-${hostMark()}-`))
		expect(fs.statSync(scratch.dir).mode & 0o777).toBe(0o700)
		scratch.remove()
		expect(fs.existsSync(scratch.dir)).toBe(false)
	})

	it("sweeps what a gone process left at a prefix's first scratch, and only then", () => {
		const leftover = path.join(os.tmpdir(), `comb-cleanup-sweep-${DEAD}-${hostMark()}-gone`)
		fs.mkdirSync(leftover)
		const first = scratchDir("comb-cleanup-sweep-")
		expect(fs.existsSync(leftover)).toBe(false)
		fs.mkdirSync(leftover)
		const second = scratchDir("comb-cleanup-sweep-")
		expect(fs.existsSync(leftover)).toBe(true)
		for (const each of [first, second]) each.remove()
		fs.rmSync(leftover, { force: true, recursive: true })
	})
})

describe("a signal (S2, KC5 and PA4 of r22)", () => {
	const kill = stubKill()

	it.each([["SIGINT"], ["SIGTERM"]] as const)(
		"on %s runs every held step once, then ends the process by it again",
		async (signal) => {
			const steps = [vi.fn(), vi.fn(async () => undefined)]
			const releases = steps.map((step) => hold(step))
			await deliver(signal)
			expect([steps.map((step) => step.mock.calls), kill.calls()]).toEqual([
				[[[signal]], [[signal]]],
				[[process.pid, signal]],
			])
			for (const release of releases) release()
		},
	)

	it("runs no released step, and still ends the process: the listener stays, so no signal is lost", async () => {
		const step = vi.fn()
		hold(step)()
		await deliver("SIGINT")
		expect([step.mock.calls, kill.calls()]).toEqual([[], [[process.pid, "SIGINT"]]])
	})
})

describe("a signal, on what comb holds and with a host listening", () => {
	const kill = stubKill()

	it("removes a held scratch, and the steps onSignals holds", async () => {
		const scratch = scratchDir("comb-cleanup-signal-")
		const cleanup = vi.fn(async () => undefined)
		await onSignals(cleanup, async () => deliver("SIGTERM"))
		expect([fs.existsSync(scratch.dir), cleanup.mock.calls.length]).toEqual([false, 1])
		scratch.remove()
	})

	it("leaves the end to a host that listens for the signal itself", async () => {
		const host = vi.fn()
		process.on("SIGTERM", host)
		for (const listener of worker.SIGTERM) process.off("SIGTERM", listener)
		try {
			const step = vi.fn()
			const release = hold(step)
			process.emit("SIGTERM", "SIGTERM")
			await settle()
			release()
			expect([step.mock.calls.length, host.mock.calls.length, kill.calls()]).toEqual([1, 1, []])
		} finally {
			process.off("SIGTERM", host)
			for (const listener of worker.SIGTERM) process.on("SIGTERM", listener)
		}
	})
})

describe("a signal's steps, in order (PA4 of r22)", () => {
	const kill = stubKill()

	it("runs the steps last held first, each after the one before ends, as a child stops before what it used goes", async () => {
		const order: string[] = []
		const releases = [
			hold(() => order.push("scratch")),
			hold(async () => {
				order.push("child stopping")
				await settle()
				order.push("child stopped")
			}),
		]
		try {
			await deliver("SIGTERM")
			await until(() => kill.calls().length > 0, "the end")
			expect(order).toEqual(["child stopping", "child stopped", "scratch"])
		} finally {
			for (const release of releases) release()
		}
	})

	it("runs the next step past one that throws", async () => {
		const after = vi.fn()
		const releases = [hold(after), hold(() => Promise.reject(new Error("step")))]
		try {
			await deliver("SIGINT")
			await until(() => kill.calls().length > 0, "the end")
			expect([after.mock.calls, kill.calls()]).toEqual([[["SIGINT"]], [[process.pid, "SIGINT"]]])
		} finally {
			for (const release of releases) release()
		}
	})
})

describe("work a signal's stop holds (PA4 of r22)", () => {
	stubKill()

	it("lets work through at once with no stop running, and a step's own work through during one", async () => {
		await pastStop()
		const host = vi.fn()
		process.on("SIGTERM", host)
		for (const listener of worker.SIGTERM) process.off("SIGTERM", listener)
		const order: string[] = []
		try {
			const release = hold(async () => {
				await pastStop()
				order.push("step's own work")
				await settle()
				order.push("step done")
			})
			try {
				process.emit("SIGTERM", "SIGTERM")
				await pastStop().then(() => order.push("work outside"))
			} finally {
				release()
			}
			/* a host that listens ends the process its own way: once the steps end, work outside goes on */
			expect(order).toEqual(["step's own work", "step done", "work outside"])
			await pastStop()
		} finally {
			process.off("SIGTERM", host)
			for (const listener of worker.SIGTERM) process.on("SIGTERM", listener)
		}
	})
})

describe("a second signal while a stop's steps run (PA4 of r22)", () => {
	const kill = stubKill()

	it("ends the process once, after the first stop's steps end", async () => {
		const { promise: stopped, resolve: stop } = Promise.withResolvers<void>()
		const order: string[] = []
		const release = hold(async () => {
			order.push("step started")
			await stopped
			order.push("step done")
		})
		try {
			await deliver("SIGTERM")
			await deliver("SIGTERM")
			order.push(`ends asked while the step runs: ${kill.calls().length}`)
			stop()
			await settle()
			await settle()
		} finally {
			release()
		}
		/* a supervisor that sends SIGTERM twice must not end comb before the child it stops has ended */
		expect([order, kill.calls()]).toEqual([
			["step started", "ends asked while the step runs: 0", "step done"],
			[[process.pid, "SIGTERM"]],
		])
	})

	it("holds work outside until the first stop's steps end, with a host listening", async () => {
		const { promise: stopped, resolve: stop } = Promise.withResolvers<void>()
		const host = vi.fn()
		process.on("SIGTERM", host)
		for (const listener of worker.SIGTERM) process.off("SIGTERM", listener)
		const order: string[] = []
		try {
			const release = hold(async () => {
				order.push("step started")
				await stopped
				order.push("step done")
			})
			try {
				process.emit("SIGTERM", "SIGTERM")
				process.emit("SIGTERM", "SIGTERM")
				const outside = pastStop().then(() => order.push("work outside"))
				await settle()
				order.push("both signals in")
				stop()
				await outside
			} finally {
				release()
			}
			expect([order, kill.calls()]).toEqual([["step started", "both signals in", "step done", "work outside"], []])
			await pastStop()
		} finally {
			process.off("SIGTERM", host)
			for (const listener of worker.SIGTERM) process.on("SIGTERM", listener)
		}
	})
})
