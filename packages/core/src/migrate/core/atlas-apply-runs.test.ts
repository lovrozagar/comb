/**
 * applyRuns (atlas-apply-runs.ts): the approved files applied one Atlas call each (PA1 of r22b),
 * each later call after a status read and a history check, and a call that ran another file, or
 * none, refused as it is
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { fakeAtlas, file, ok, ranWhole, status } from "../../../tests/support/fake-atlas.ts"
import { deliver, stubKill, until } from "../../../tests/support/signals.ts"
import { applyRuns } from "./atlas-apply-runs.ts"
import type { AtlasStatus } from "./atlas-history.ts"
import type { RunResult } from "./process.ts"

/* three files, the second with a SET that outlives its COMMIT */
const FILES: ReadonlyArray<[string, string]> = [
	["1_a.sql", "CREATE TABLE a (id int);\n"],
	["2_b.sql", "SET lock_timeout = 0;\n"],
	["3_c.sql", "CREATE TABLE c (id int);\n"],
]
const NAMES = FILES.map(([name]) => name)

let dir = ""
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "comb-atlas-apply-runs-"))
	for (const [name, sql] of FILES) writeFileSync(join(dir, name), sql)
})
afterEach(() => rmSync(dir, { force: true, recursive: true }))

const TARGET = { devUrl: "postgres://localhost/dev", lockTimeout: "5s", schema: "public", url: "postgres://app@db/app" }
const PENDING = status({ available: NAMES.map(file), pending: NAMES.map(file), status: "PENDING" })
/* the status once every file ran, here or by another apply */
const DONE = status({ applied: NAMES.map(ranWhole), available: NAMES.map(file), status: "OK" })
/** Atlas's report of an apply of `names` */
const report = (...names: string[]) =>
	ok(JSON.stringify({ applied: names.map((Name) => ({ Name })), error: "", target: "3" }))

/** applyRuns of the three files on `atlas`: what it returns or throws, the amounts it asked, what it printed */
function applied(atlas: ReturnType<typeof fakeAtlas>) {
	const out: string[] = []
	const options = { dir, exec: atlas, print: (line: string) => out.push(line), target: TARGET }
	const run = () =>
		applyRuns(options, dir, {
			foreign: { elsewhere: false, ignored: new Map(), unread: undefined },
			report: { elsewhere: false, scrub: (text: string) => text, unread: undefined },
			status: JSON.parse(PENDING.stdout) as AtlasStatus,
		})
	const amounts = () =>
		atlas.calls
			.filter((call) => call.args[1] === "apply")
			.map((call) => call.args.at(call.args.indexOf("--format") + 2))
	return { amounts, out, run }
}

describe("applyRuns", () => {
	it("applies each file in a call of its own, the status read again between", async () => {
		const atlas = fakeAtlas({ apply: report(...NAMES), status: PENDING })
		const { amounts, out, run } = applied(atlas)
		expect(await run()).toEqual(NAMES)
		expect([amounts(), out]).toEqual([["1", "1", "1"], NAMES.map((name) => `Apply: ${name}`)])
		expect(atlas.calls.filter((call) => call.args[1] === "status")).toHaveLength(2)
	})

	it("refuses a call that ran another file than the one pending first", async () => {
		const { run } = applied(fakeAtlas({ apply: report("2_b.sql"), status: PENDING }))
		await expect(run()).rejects.toThrow("atlas migrate apply 1 ran 2_b.sql, not the approved 1_a.sql")
	})

	it("stops once another apply ran the rest", async () => {
		const atlas = fakeAtlas({ apply: report(...NAMES), status: PENDING, statusAfterApply: DONE })
		const { amounts, run } = applied(atlas)
		expect([await run(), amounts()]).toEqual([["1_a.sql"], ["1"]])
	})
})

describe("applyRuns, a call that ran nothing", () => {
	it("refuses it while files are still pending, naming them", async () => {
		const { run } = applied(
			fakeAtlas({ apply: ok(JSON.stringify({ applied: null, error: "", target: "" })), status: PENDING }),
		)
		await expect(run()).rejects.toThrow(
			"atlas migrate apply ran nothing and reported no error, yet still pending: 1_a.sql, 2_b.sql, 3_c.sql",
		)
	})

	it("says there was nothing to apply when another apply ran every file", async () => {
		const atlas = fakeAtlas({
			apply: ok(JSON.stringify({ applied: null, error: "", target: "" })),
			status: PENDING,
			statusAfterApply: DONE,
		})
		const { out, run } = applied(atlas)
		expect([await run(), out]).toEqual([[], ["No migrations to apply"]])
	})

	it("returns what it applied, silently, when it was a later call and another apply ran the rest", async () => {
		const atlas = fakeAtlas({ apply: report("1_a.sql", "2_b.sql"), status: PENDING })
		let reads = 0
		const raced = Object.assign(
			async (cmd: string, args: readonly string[], runOptions?: Parameters<typeof atlas>[2]) =>
				/* the status after the call that ran nothing: another apply ran 3_c.sql */
				args[1] === "status" && ++reads === 3 ? DONE : atlas(cmd, args, runOptions),
			{ calls: atlas.calls, replayed: atlas.replayed },
		)
		const { amounts, out, run } = applied(raced)
		expect([await run(), amounts(), out]).toEqual([
			["1_a.sql", "2_b.sql"],
			["1", "1", "1"],
			["Apply: 1_a.sql", "Apply: 2_b.sql"],
		])
	})
})

/** `atlas`, with SIGTERM to comb once its first apply call answered, and `after` for each status read past it */
function signalledAfterFirstCall(atlas: ReturnType<typeof fakeAtlas>, after?: RunResult) {
	let signalled = false
	return Object.assign(
		async (cmd: string, args: readonly string[], runOptions?: Parameters<typeof atlas>[2]) => {
			if (signalled && after !== undefined && args[1] === "status") return after
			const answer = await atlas(cmd, args, runOptions)
			if (args[1] === "apply" && !signalled) {
				signalled = true
				await deliver("SIGTERM")
			}
			return answer
		},
		{ calls: atlas.calls, replayed: atlas.replayed },
	)
}

describe("applyRuns stopped by a signal (PA4 of r22)", () => {
	const kill = stubKill()

	/** What the stop printed once it asked for its end, and the ends it asked for */
	async function stoppedLines(after?: RunResult) {
		const { out, run } = applied(
			signalledAfterFirstCall(fakeAtlas({ apply: report(...NAMES), status: PENDING }), after),
		)
		await run().catch(() => undefined)
		await until(() => kill.calls().length > 0, "the end the stop asks for")
		return [out.filter((line) => line.startsWith("Stopped by ")), kill.calls()]
	}

	it.each([
		["the first call's file", undefined, "applied 1_a.sql; not applied 2_b.sql, 3_c.sql"],
		["none", PENDING, "applied none; not applied 1_a.sql, 2_b.sql, 3_c.sql"],
		["every file", DONE, "applied 1_a.sql, 2_b.sql, 3_c.sql; not applied none"],
	])("says once which approved files the history records, %s here, then ends by the signal", async (_, after, said) => {
		expect(await stoppedLines(after)).toEqual([[`Stopped by SIGTERM: ${said}`], [[process.pid, "SIGTERM"]]])
	})

	it("says it could not read what was applied when the history read fails, and still ends by the signal", async () => {
		const [lines, ends] = await stoppedLines({ code: 1, stderr: "connection refused", stdout: "" })
		expect([lines, ends]).toEqual([
			[expect.stringMatching(/^Stopped by SIGTERM: comb could not read what was applied: .*connection refused/)],
			[[process.pid, "SIGTERM"]],
		])
	})
})
