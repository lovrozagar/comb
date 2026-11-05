#!/usr/bin/env bun
// Managed by ~/Development/standards (files/scripts/ci-wait.ts). Edit it there, then run `bun sync.ts`.
// `bun scripts/ci-wait.ts [sha] [--workflow ci.yml] [--branch main] [--grace 600] [--poll 30]`: wait for CI's push run on
// a commit (HEAD by default) and say how it ended. CI is the full gate, so this is how a push is checked: on a failure
// it names the failed jobs and saves their logs under .tmp/grunt/ci/, so the loop is read the log, fix, commit, push,
// wait again. Only `push` runs on the branch count, as the release gate counts them.
//
// Exit 0: passed. 1: failed, cancelled, or no run within the grace (the commit was never pushed). 2: a newer push
// cancelled this run; wait on that commit instead.
import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

export type RunState = {
	status: string
	conclusion: string | null
	databaseId: number
	url: string
	createdAt: string
	headSha: string
}

export type Outcome =
	| { kind: "passed"; url: string }
	| { kind: "failed"; url: string; id: number; jobs: string[]; log: string }
	| { kind: "superseded"; url: string; newer: string; newerSha: string }
	| { kind: "cancelled"; url: string; id: number }
	| { kind: "absent" }

export type CiWaitDeps = {
	gh: (args: readonly string[]) => { code: number; stdout: string; stderr: string }
	sleep: (s: number) => Promise<void>
	// Milliseconds since the epoch.
	now: () => number
	writeLog: (path: string, body: string) => void
	log: (line: string) => void
}

export type CiWaitOptions = { sha: string; workflow: string; branch: string; graceSeconds: number; pollSeconds: number }

const FIELDS = "status,conclusion,databaseId,url,createdAt,headSha"

function gh(deps: CiWaitDeps, args: readonly string[]): string {
	const result = deps.gh(args)
	if (result.code !== 0) throw new Error(`gh ${args.join(" ")} exited ${result.code}: ${result.stderr.trim()}`)
	return result.stdout
}

function parseJson(text: string, what: string): unknown {
	try {
		return JSON.parse(text)
	} catch {
		throw new Error(`gh returned malformed JSON for ${what}: ${text.slice(0, 200)}`)
	}
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

// `gh run list --json` at the edge: an array of runs with every field typed, or an error naming what is off.
export function parseRuns(text: string): RunState[] {
	const raw = parseJson(text, "gh run list")
	if (!Array.isArray(raw)) throw new Error(`gh run list returned ${typeof raw}, not an array of runs`)
	return raw.map((run, index) => {
		const ok =
			isRecord(run) &&
			typeof run.status === "string" &&
			(run.conclusion === null || typeof run.conclusion === "string") &&
			typeof run.databaseId === "number" &&
			typeof run.url === "string" &&
			typeof run.createdAt === "string" &&
			!Number.isNaN(Date.parse(run.createdAt)) &&
			typeof run.headSha === "string"
		if (!ok) throw new Error(`gh run list returned a run ${index} without the fields ${FIELDS}: ${JSON.stringify(run)}`)
		return {
			conclusion: run.conclusion as string | null,
			createdAt: run.createdAt as string,
			databaseId: run.databaseId as number,
			headSha: run.headSha as string,
			status: run.status as string,
			url: run.url as string,
		}
	})
}

// `gh run view --json jobs` at the edge: the names of the jobs that failed.
export function parseFailedJobs(text: string): string[] {
	const raw = parseJson(text, "gh run view")
	const jobs = isRecord(raw) ? raw.jobs : undefined
	if (!Array.isArray(jobs)) throw new Error(`gh run view returned no jobs array: ${text.slice(0, 200)}`)
	return jobs.flatMap((job) => {
		if (
			!isRecord(job) ||
			typeof job.name !== "string" ||
			!(job.conclusion === null || typeof job.conclusion === "string")
		)
			throw new Error(`gh run view returned a job without name and conclusion: ${JSON.stringify(job)}`)
		return job.conclusion === "failure" || job.conclusion === "timed_out" ? [job.name] : []
	})
}

// The `gh run list` arguments that select the workflow's push runs on the branch.
const pushRuns = (opts: CiWaitOptions) => [
	"run",
	"list",
	"--workflow",
	opts.workflow,
	"--branch",
	opts.branch,
	"--event",
	"push",
]

const newest = (runs: readonly RunState[]) =>
	runs.toSorted((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0]

// Wait for the commit's push runs to settle. A success among them wins, a run still going is waited on, and otherwise
// the newest completed run decides. gh failing or answering in another shape is an error, never a pass.
export async function waitForCi(deps: CiWaitDeps, opts: CiWaitOptions): Promise<Outcome> {
	const start = deps.now()
	let said = ""
	const say = (line: string) => {
		if (line !== said) deps.log(line)
		said = line
	}
	for (;;) {
		const runs = parseRuns(gh(deps, [...pushRuns(opts), "--commit", opts.sha, "--limit", "20", "--json", FIELDS]))
		const passed = runs.find((run) => run.conclusion === "success")
		if (passed) return { kind: "passed", url: passed.url }
		const going = runs.filter((run) => run.status !== "completed")
		const last = newest(runs)
		if (going.length > 0) {
			say(`ci-wait: waiting on ${going.map((run) => `${run.url} (${run.status})`).join(", ")}`)
		} else if (last) {
			return settle(deps, opts, last)
		} else if (deps.now() - start >= opts.graceSeconds * 1000) {
			return { kind: "absent" }
		} else {
			say(`ci-wait: no push run of ${opts.workflow} on ${opts.branch} at ${opts.sha.slice(0, 12)} yet`)
		}
		await deps.sleep(opts.pollSeconds)
	}
}

function settle(deps: CiWaitDeps, opts: CiWaitOptions, run: RunState): Outcome {
	if (run.conclusion === "cancelled") {
		const recent = parseRuns(gh(deps, [...pushRuns(opts), "--limit", "5", "--json", FIELDS]))
		const newer = recent.find(
			(other) => other.headSha !== opts.sha && Date.parse(other.createdAt) > Date.parse(run.createdAt),
		)
		return newer
			? { kind: "superseded", newer: newer.url, newerSha: newer.headSha, url: run.url }
			: { id: run.databaseId, kind: "cancelled", url: run.url }
	}
	const id = String(run.databaseId)
	const jobs = parseFailedJobs(gh(deps, ["run", "view", id, "--json", "jobs"]))
	const log = `.tmp/grunt/ci/${opts.sha.slice(0, 12)}-${id}.log`
	// A run that failed before any job did (startup_failure, action_required, a run-level timeout) has no failed log, and
	// gh exits nonzero for it. The outcome still names the run; the log file says why it holds no job output.
	const args = ["run", "view", id, "--log-failed"]
	const fetched = deps.gh(args)
	deps.writeLog(
		log,
		fetched.code === 0
			? fetched.stdout
			: `ci-wait: could not fetch the failed logs: gh ${args.join(" ")} exited ${fetched.code}\n${fetched.stderr}`,
	)
	return { id: run.databaseId, jobs, kind: "failed", log, url: run.url }
}

// The exit code and the one line a person reads for each outcome.
export function report(outcome: Outcome, opts: CiWaitOptions): { code: number; line: string } {
	const at = `${opts.workflow} on ${opts.branch} at ${opts.sha.slice(0, 12)}`
	switch (outcome.kind) {
		case "passed":
			return { code: 0, line: `ci-wait: ${at} passed: ${outcome.url}` }
		case "failed": {
			const jobs = outcome.jobs.length > 0 ? outcome.jobs.join(", ") : "no job marked failed"
			return {
				code: 1,
				line: `ci-wait: ${at} failed (${jobs}): ${outcome.url}. The failed logs are in ${outcome.log}; fix, commit, push and run ci-wait again`,
			}
		}
		case "cancelled":
			return {
				code: 1,
				line: `ci-wait: ${at} was cancelled, and no newer push replaced it: ${outcome.url}. Re-run it with gh run rerun ${outcome.id}`,
			}
		case "superseded":
			return {
				code: 2,
				line: `ci-wait: ${at} was cancelled by a newer push (${outcome.newer}): wait on that one with bun scripts/ci-wait.ts ${outcome.newerSha}`,
			}
		case "absent":
			return {
				code: 1,
				line: `ci-wait: ${at} has no push run after ${opts.graceSeconds} s: the commit was never pushed to ${opts.branch}`,
			}
	}
}

function seconds(flag: string, value: string | undefined): number {
	const n = Number(value)
	if (!Number.isInteger(n) || n < 0) throw new Error(`${flag} takes whole seconds, not ${value ?? "nothing"}`)
	return n
}

// The command line at the edge: an optional commit, then flags with a value each.
export function parseArgs(argv: readonly string[]): { rev: string } & Omit<CiWaitOptions, "sha"> {
	const out = { branch: "main", graceSeconds: 600, pollSeconds: 30, rev: "HEAD", workflow: "ci.yml" }
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] as string
		const value = argv[i + 1]
		if (arg === "--workflow" || arg === "--branch") {
			if (value === undefined || value.startsWith("--")) throw new Error(`${arg} takes a value`)
			out[arg === "--workflow" ? "workflow" : "branch"] = value
			i++
		} else if (arg === "--grace" || arg === "--poll") {
			out[arg === "--grace" ? "graceSeconds" : "pollSeconds"] = seconds(arg, value)
			i++
		} else if (arg.startsWith("--")) {
			throw new Error(`unknown flag ${arg}`)
		} else {
			out.rev = arg
		}
	}
	return out
}

function exec(cmd: string, args: readonly string[]) {
	const result = spawnSync(cmd, args, { encoding: "utf8" })
	return { code: result.status ?? 1, stderr: result.stderr ?? String(result.error ?? ""), stdout: result.stdout ?? "" }
}

async function main(argv: readonly string[]): Promise<number> {
	try {
		const { rev, ...rest } = parseArgs(argv)
		const resolved = exec("git", ["rev-parse", "--verify", `${rev}^{commit}`])
		if (resolved.code !== 0) throw new Error(`git cannot resolve ${rev} to a commit: ${resolved.stderr.trim()}`)
		const root = exec("git", ["rev-parse", "--show-toplevel"]).stdout.trim()
		const opts = { sha: resolved.stdout.trim(), ...rest }
		const outcome = await waitForCi(
			{
				gh: (args) => exec("gh", args),
				log: (line) => console.error(line),
				now: () => Date.now(),
				sleep: (s) => Bun.sleep(s * 1000),
				writeLog: (path, body) => {
					const abs = join(root, path)
					mkdirSync(dirname(abs), { recursive: true })
					writeFileSync(abs, body)
				},
			},
			opts,
		)
		const { code, line } = report(outcome, opts)
		console.log(line)
		return code
	} catch (error) {
		console.error(`ci-wait: ${error instanceof Error ? error.message : String(error)}`)
		return 1
	}
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)))
