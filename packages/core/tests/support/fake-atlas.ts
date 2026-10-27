/**
 * A fake Atlas for the apply tests: hash writes atlas.sum from the files' name lengths, a schema
 * diff records the history it replayed, and status, inspect, dry run and apply answer as told.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { sqlFiles } from "../../src/migrate/core/atlas-dir.ts"
import type { Run, RunResult } from "../../src/migrate/core/process.ts"

const ok = (stdout = ""): RunResult => ({ code: 0, stderr: "", stdout })
const fail = (stderr: string, stdout = ""): RunResult => ({ code: 1, stderr, stdout })
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
	apply?: RunResult
	dryRun?: RunResult
	inspect?: RunResult
	schemaDiff?: RunResult
	status?: RunResult
}
type Fake = Run & {
	calls: Array<{ args: string[]; env: Readonly<Record<string, string | undefined>> | undefined }>
	/** each file of the history a schema diff replayed */
	replayed: string[]
}

/** Atlas: hash writes a sum of name lengths, status and apply answer as told */
function fakeAtlas(answers: Answers): Fake {
	const calls: Fake["calls"] = []
	const replayed: string[] = []
	const run: Run = (_cmd, args, runOptions) => {
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
		if (args[1] === "status") return answers.status ?? ok("{}")
		if (args[1] === "inspect") return answers.inspect ?? ok("{}")
		if (args[0] === "schema") {
			const to = (args[args.indexOf("--to") + 1] as string).replace("file://", "")
			replayed.push(...sqlFiles(to).map((name) => readFileSync(join(to, name), "utf8")))
			return answers.schemaDiff ?? ok("Schemas are synced, no changes to be made.\n")
		}
		return args.includes("--dry-run") ? (answers.dryRun ?? ok("{}")) : (answers.apply ?? ok("{}"))
	}
	return Object.assign(run, { calls, replayed })
}

const status = (body: Record<string, unknown>) =>
	ok(JSON.stringify({ applied: [], available: [], current: "", error: "", pending: [], status: "OK", ...body }))

export { type Answers, fail, type Fake, fakeAtlas, file, ok, revision, status }
