/**
 * A fake Atlas for the apply tests: hash writes atlas.sum from the files' name lengths, a schema
 * diff records the history it replayed, and status, inspect, dry run and apply answer as told. An
 * apply of n files, as comb runs each run of files that may share a session (PA1 of r22b), answers
 * with the report's next n files, and status then leaves the files reported out of its pending.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { sqlFiles } from "../../src/migrate/core/atlas-dir.ts"
import type { Run, RunResult } from "../../src/migrate/core/process.ts"

const ok = (stdout = ""): RunResult => ({ code: 0, stderr: "", stdout })
const fail = (stderr: string, stdout = ""): RunResult => ({ code: 1, stderr, stdout })
/** Atlas's apply report when it ran no file */
const NOTHING: RunResult = ok(JSON.stringify({ applied: null, error: "", target: "" }))
const file = (name: string) => ({ Description: name.split("_")[1], Name: name, Version: name.split("_")[0] })
/* a revision as Atlas records one of the fixture's files: 1_a.sql, 2_b.sql */
const revision = (version: string, more: Record<string, unknown> = {}) => ({
	applied: 1,
	description: ({ "1": "a", "2": "b" } as Record<string, string>)[version] ?? "",
	error: "",
	errorStmt: "",
	hash: `${version.length}=`,
	total: 1,
	type: "applied",
	version,
	...more,
})

type Answers = {
	/** the report of an apply of every pending file, which an apply of n files answers n files of at a time */
	apply?: RunResult
	dryRun?: RunResult
	inspect?: RunResult
	schemaDiff?: RunResult
	status?: RunResult
	/** status once an apply ran, as another apply or a skipped file leaves it; `status` until then */
	statusAfterApply?: RunResult
}
type Fake = Run & {
	calls: Array<{ args: string[]; env: Readonly<Record<string, string | undefined>> | undefined }>
	/** each file of the history a schema diff replayed */
	replayed: string[]
}

/**
 * The answer to an apply of `amount` files under `whole`, an apply's report, once `taken` were
 * reported: the report's next files, with its error and exit code when one failed or the last is
 * among them; none once the report is spent
 */
function nextOf(whole: RunResult, taken: string[], amount: number): RunResult {
	const report = JSON.parse(whole.stdout) as { applied: Array<{ Error?: unknown; Name: string }> | null; error: string }
	const files = report.applied ?? []
	if (taken.length === 0 && files.length === 0) return whole
	const next = files.slice(taken.length, taken.length + amount)
	const failed = next.findIndex((entry) => entry.Error !== undefined)
	const ran = failed === -1 ? next : next.slice(0, failed + 1)
	if (ran.length === 0) return NOTHING
	taken.push(...ran.map((entry) => entry.Name))
	const last = failed !== -1 || taken.length === files.length
	const stdout = JSON.stringify({ ...report, applied: ran, error: last ? report.error : "" })
	return last ? { ...whole, stdout } : ok(stdout)
}

/** `answer`, a status, with the files an apply reported left out of its pending */
function pendingAfter(answer: RunResult, taken: readonly string[]): RunResult {
	if (taken.length === 0 || !answer.stdout.startsWith("{")) return answer
	const body = JSON.parse(answer.stdout) as { pending?: Array<{ Name: string }> | null }
	return {
		...answer,
		stdout: JSON.stringify({ ...body, pending: (body.pending ?? []).filter((entry) => !taken.includes(entry.Name)) }),
	}
}

/** Atlas: hash writes a sum of name lengths, status and apply answer as told */
function fakeAtlas(answers: Answers): Fake {
	const calls: Fake["calls"] = []
	const replayed: string[] = []
	let applied = false
	const taken: string[] = []
	const run: Run = async (_cmd, args, runOptions) => {
		calls.push({ args: [...args], env: runOptions?.env })
		if (args[1] === "hash") {
			const dir = (args[args.indexOf("--dir") + 1] as string).replace("file://", "")
			writeFileSync(
				join(dir, "atlas.sum"),
				`h1:x=\n${sqlFiles(dir)
					.map((f) => `${f} h1:${f.length}=`)
					.join("\n")}\n`,
			)
			return ok()
		}
		if (args[1] === "status")
			return (applied ? answers.statusAfterApply : undefined) ?? pendingAfter(answers.status ?? ok("{}"), taken)
		if (args[1] === "inspect") return answers.inspect ?? ok("{}")
		if (args[0] === "schema") {
			const to = (args[args.indexOf("--to") + 1] as string).replace("file://", "")
			replayed.push(...sqlFiles(to).map((name) => readFileSync(join(to, name), "utf8")))
			return answers.schemaDiff ?? ok("Schemas are synced, no changes to be made.\n")
		}
		if (args.includes("--dry-run")) return answers.dryRun ?? NOTHING
		applied = true
		const whole = answers.apply ?? NOTHING
		/* comb's amount follows its --format and the format's value */
		const amount = Number(args[args.indexOf("--format") + 2])
		return Number.isInteger(amount) && whole.stdout.startsWith("{") ? nextOf(whole, taken, amount) : whole
	}
	return Object.assign(run, { calls, replayed })
}

const status = (body: Record<string, unknown>) =>
	ok(JSON.stringify({ applied: [], available: [], current: "", error: "", pending: [], status: "OK", ...body }))

export { type Answers, fail, type Fake, fakeAtlas, file, ok, revision, status }
