/**
 * PA4 of r22: a Postgres apply stopped by SIGINT or SIGTERM to comb's pid alone, as a supervisor, a
 * container stop or a CI step timeout sends it, while Atlas applies. comb passes the signal to Atlas,
 * waits for it to end, reads the history once and says what was applied and what was not, then ends
 * as the signal would: no Atlas left running, nothing after the stopped file recorded, and no
 * scratch left. The Atlas here is the real one behind a stand-in that holds the second apply call
 * until a signal ends it, so the stop lands between the two files' calls.
 */
import { spawn, spawnSync } from "node:child_process"
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { hashDir } from "../../../src/migrate/core/atlas-dir.ts"
import { run } from "../../../src/migrate/core/process.ts"
import { running, runs, type Seen, see, send } from "../../support/pid.ts"
import { withScratchDb } from "../support/pg.ts"
import { query } from "../support/pg-roles.ts"

let root = ""
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "comb-apply-interrupt-"))
})
afterEach(() => rmSync(root, { force: true, recursive: true }))

/* the real Atlas, which the stand-in runs for every call but the held one */
const REAL_ATLAS = spawnSync("sh", ["-c", "command -v atlas"], { encoding: "utf8" }).stdout.trim()

/**
 * An `atlas` that runs the real one, except the second `migrate apply` call that is no dry run: that
 * one writes its pid to `<state>.pid` and waits until a signal ends it, as Atlas mid-file would
 */
const STAND_IN = `#!${process.execPath}
const { spawnSync } = require("node:child_process")
const fs = require("node:fs")
const args = process.argv.slice(2)
const state = process.env.COMB_STAND_IN_STATE
const applies = args[0] === "migrate" && args[1] === "apply" && !args.includes("--dry-run")
const call = applies ? Number(fs.existsSync(state) ? fs.readFileSync(state, "utf8") : "0") + 1 : 0
if (applies) fs.writeFileSync(state, String(call))
if (call === 2) {
	fs.writeFileSync(state + ".pid", String(process.pid))
	setInterval(() => {}, 1000)
} else {
	const real = spawnSync(process.env.COMB_REAL_ATLAS, args, { stdio: "inherit" })
	process.exit(real.status ?? 1)
}
`

/** Two files: the first ends its session run with a SET, so the second gets an Atlas call of its own (PA1 of r22b) */
const FILES = [
	"CREATE TABLE a (id int PRIMARY KEY);\nSET statement_timeout = 0;\n",
	"CREATE TABLE b (id int PRIMARY KEY);\n",
]
const NAMES = ["20260101000000_a.sql", "20260101000001_b.sql"]

/**
 * The apply of `dir` in a child under a shell that says how it ended; `comb` is the apply, seen as
 * the shell's child as soon as it writes its pid, and `kill` signals it alone
 */
function childApply(env: NodeJS.ProcessEnv, target: { devUrl: string; dir: string; url: string }) {
	const child = spawn(
		"sh",
		[
			"-c",
			'bun "$0" "$1"; echo "exit $?"',
			join(import.meta.dirname, "../support/apply-child.ts"),
			JSON.stringify(target),
		],
		{
			env,
			stdio: ["ignore", "pipe", "inherit"],
		},
	)
	let said = ""
	let comb: Seen | undefined
	child.stdout.on("data", (chunk: Buffer) => {
		said += chunk.toString()
		/* read as the line comes, while the shell, which Node has not reaped, holds the apply as its child */
		comb ??= see(Number(/^pid (\d+)$/m.exec(said)?.[1]), child.pid)
	})
	const ended = new Promise<string[]>((done) => child.on("close", () => done(said.trim().split("\n"))))
	const seen = (): Seen => {
		if (comb === undefined) throw new Error(`the apply never wrote its pid as the shell's child: ${said}`)
		return comb
	}
	return { comb: seen, ended, kill: (sent: NodeJS.Signals) => expect(send(seen(), sent)).toBe(true), said: () => said }
}

/* how long comb has to end once signalled, well under the case's timeout, so withScratchDb still drops its databases */
const STOP_WITHIN_MS = 20_000

/**
 * What comb said, once it ended after the signal; if it has not ended within STOP_WITHIN_MS, comb
 * and its Atlas child are killed and the case fails with their pids and state, so a red run leaves
 * nothing running and nothing on the server
 */
async function endedWithin(child: ReturnType<typeof childApply>, atlas: Seen): Promise<string[]> {
	let timer: NodeJS.Timeout | undefined
	const late = new Promise<"late">((done) => {
		timer = setTimeout(() => done("late"), STOP_WITHIN_MS)
	})
	const end = await Promise.race([child.ended, late])
	clearTimeout(timer)
	if (end !== "late") return end
	const comb = child.comb()
	const state = { atlasRunning: runs(atlas), combRunning: runs(comb), said: child.said().trim().split("\n") }
	for (const each of [comb, atlas]) send(each, "SIGKILL")
	await child.ended
	throw new Error(
		`comb ${comb.pid} (Atlas ${atlas.pid}) had not ended ${STOP_WITHIN_MS} ms after the signal: ${JSON.stringify(state)}`,
	)
}

/** Until `done` holds, at most 60 s */
async function until(done: () => boolean, what: string): Promise<void> {
	for (let tries = 0; !done(); tries++) {
		if (tries > 1200) throw new Error(`never: ${what}`)
		await new Promise((resolve) => setTimeout(resolve, 50))
	}
}

describe("a Postgres apply stopped by a signal while Atlas applies (PA4 of r22)", () => {
	it.each([
		["SIGINT", 130],
		["SIGTERM", 143],
	] as const)(
		"on %s passes it to Atlas, says once what was applied, records nothing after, and ends as the signal would",
		async (signal, code) => {
			const [dir, bin, tmp] = [join(root, "m"), join(root, "bin"), join(root, "tmp")]
			for (const each of [dir, bin, tmp]) mkdirSync(each)
			FILES.forEach((sql, i) => writeFileSync(join(dir, NAMES[i] as string), sql))
			await hashDir(run, dir)
			writeFileSync(join(bin, "atlas"), STAND_IN)
			chmodSync(join(bin, "atlas"), 0o755)
			const state = join(root, "state")
			await withScratchDb((devUrl) =>
				withScratchDb(async (url) => {
					const env = {
						...process.env,
						COMB_REAL_ATLAS: REAL_ATLAS,
						COMB_STAND_IN_STATE: state,
						PATH: `${bin}:${process.env["PATH"] ?? ""}`,
						TMPDIR: tmp,
					}
					const child = childApply(env, { devUrl, dir, url })
					await until(() => existsSync(`${state}.pid`), "the held apply call")
					/* the held Atlas call, seen as comb's child while it waits for the signal */
					const atlas = running(Number(readFileSync(`${state}.pid`, "utf8")), child.comb().pid)
					child.kill(signal)
					const said = await endedWithin(child, atlas)
					const revisions = await query(
						url,
						"SELECT version FROM atlas_schema_revisions.atlas_schema_revisions ORDER BY version",
					)
					const tables = await query(
						url,
						"SELECT to_regclass('public.a') IS NOT NULL AS a, to_regclass('public.b') IS NOT NULL AS b",
					)
					expect({
						atlasRunning: runs(atlas),
						end: said.at(-1),
						left: readdirSync(tmp),
						recorded: revisions.map((row) => String(row["version"])),
						stopped: said.filter((line) => line.startsWith("Stopped by ")),
						tables: tables[0],
					}).toEqual({
						atlasRunning: false,
						end: `exit ${code}`,
						left: [],
						recorded: ["20260101000000"],
						stopped: [`Stopped by ${signal}: applied ${NAMES[0]}; not applied ${NAMES[1]}`],
						tables: { a: true, b: false },
					})
				}),
			)
		},
		// room for until's 60 s wait for the held Atlas call, then STOP_WITHIN_MS's 20 s for the stop
		90_000,
	)
})
