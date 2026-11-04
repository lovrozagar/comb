/**
 * applyRuns (atlas-apply-runs.ts): the approved files applied one Atlas call per run of them that
 * may share a session (PA1 of r22b), each later call after a status read and a history check, and
 * a call that ran other files, or none, refused as it is
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { fakeAtlas, file, ok, status } from "../../../tests/support/fake-atlas.ts"
import { applyRuns } from "./atlas-apply-runs.ts"
import type { AtlasStatus } from "./atlas-history.ts"
import { loadPostgresParser } from "./pg-parser.ts"
import { NO_SERVER_CODE, type ServerCode, UNREAD } from "./pg-server-code.ts"
import { pgRead } from "./pg-split.ts"

beforeAll(loadPostgresParser)

/* three files, the second ending its run with a SET that outlives its COMMIT */
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
/** Atlas's report of an apply of `names` */
const report = (...names: string[]) =>
	ok(JSON.stringify({ applied: names.map((Name) => ({ Name })), error: "", target: "3" }))

/** applyRuns of the three files on `atlas`, beside a server holding `server`: what it returns or throws, the amounts it asked, what it printed */
function applied(atlas: ReturnType<typeof fakeAtlas>, server: ServerCode = NO_SERVER_CODE) {
	const out: string[] = []
	const options = { dir, exec: atlas, print: (line: string) => out.push(line), target: TARGET }
	const files = FILES.map(([name, sql]) => ({ name, read: pgRead(sql) }))
	const run = () =>
		applyRuns(options, dir, {
			files,
			foreign: { elsewhere: false, ignored: new Map(), unread: undefined },
			report: { elsewhere: false, scrub: (text: string) => text, unread: undefined },
			server,
			status: JSON.parse(PENDING.stdout) as AtlasStatus,
		})
	const amounts = () =>
		atlas.calls
			.filter((call) => call.args[1] === "apply")
			.map((call) => call.args.at(call.args.indexOf("--format") + 2))
	return { amounts, out, run }
}

describe("applyRuns", () => {
	it("applies each run of files that may share a session in one call, the status read again between", () => {
		const atlas = fakeAtlas({ apply: report(...NAMES), status: PENDING })
		const { amounts, out, run } = applied(atlas)
		expect(run()).toEqual(NAMES)
		expect([amounts(), out]).toEqual([["2", "1"], NAMES.map((name) => `Apply: ${name}`)])
		expect(atlas.calls.filter((call) => call.args[1] === "status")).toHaveLength(1)
	})

	it("gives each file a call of its own beside a server comb cannot read", () => {
		const { amounts, run } = applied(fakeAtlas({ apply: report(...NAMES), status: PENDING }), UNREAD)
		expect([run(), amounts()]).toEqual([NAMES, ["1", "1", "1"]])
	})

	it("refuses a call that ran other files than the run it was given", () => {
		const { run } = applied(fakeAtlas({ apply: report("1_a.sql"), status: PENDING }))
		expect(run).toThrow("atlas migrate apply 2 ran 1_a.sql, not the approved 1_a.sql, 2_b.sql")
	})

	it("stops once another apply ran the rest", () => {
		const atlas = fakeAtlas({ apply: report(...NAMES), status: PENDING, statusAfterApply: status({ status: "OK" }) })
		const { amounts, run } = applied(atlas)
		expect([run(), amounts()]).toEqual([["1_a.sql", "2_b.sql"], ["2"]])
	})
})

describe("applyRuns, a call that ran nothing", () => {
	it("refuses it while files are still pending, naming them", () => {
		const { run } = applied(
			fakeAtlas({ apply: ok(JSON.stringify({ applied: null, error: "", target: "" })), status: PENDING }),
		)
		expect(run).toThrow(
			"atlas migrate apply ran nothing and reported no error, yet still pending: 1_a.sql, 2_b.sql, 3_c.sql",
		)
	})

	it("says there was nothing to apply when another apply ran every file", () => {
		const atlas = fakeAtlas({
			apply: ok(JSON.stringify({ applied: null, error: "", target: "" })),
			status: PENDING,
			statusAfterApply: status({ status: "OK" }),
		})
		const { out, run } = applied(atlas)
		expect([run(), out]).toEqual([[], ["No migrations to apply"]])
	})

	it("returns what it applied, silently, when it was a later call and another apply ran the rest", () => {
		const atlas = fakeAtlas({ apply: report("1_a.sql", "2_b.sql"), status: PENDING })
		let reads = 0
		const raced = Object.assign(
			(cmd: string, args: readonly string[], runOptions?: Parameters<typeof atlas>[2]) =>
				/* the status after the call that ran nothing: another apply ran 3_c.sql */
				args[1] === "status" && ++reads === 2 ? status({ status: "OK" }) : atlas(cmd, args, runOptions),
			{ calls: atlas.calls, replayed: atlas.replayed },
		)
		const { amounts, out, run } = applied(raced)
		expect([run(), amounts(), out]).toEqual([
			["1_a.sql", "2_b.sql"],
			["2", "1"],
			["Apply: 1_a.sql", "Apply: 2_b.sql"],
		])
	})
})
