#!/usr/bin/env bun
// Managed by ~/Development/standards (files/scripts/verify.ts). Edit it there, then run `bun sync.ts`.
// `bun run verify`: every local gate in order, stopping at the first that fails with its exit code. The base four
// run in every repo; the repo's own gates follow, from `standards.gates` in package.json (set by sync from
// standards.json). On a clean tree where all pass, it stamps HEAD in `standards-verified/<sha>` of the repository's
// common git dir, which every worktree shares and nothing commits. pre-push requires the stamp of each pushed tip.
// A dirty tree is refused: the stamp would vouch for a commit the gates did not run on. So is a run missing an
// environment variable the repo declares in `standards.env`: its gates would fail inside a test runner's setup. So is
// a bun other than the one package.json's `packageManager` pins, which CI installs: a stamp from another bun vouches
// for behavior CI does not see. Off CI the gates run at idle CPU and IO priority, so a run leaves the machine usable.
import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

export type Gate = { name: string; command: readonly string[] }

const BASE = ["fmt:check", "lint", "typecheck", "test"]

// A repo whose gates name `test:coverage` runs it in the base `test`'s place: the same suite with its thresholds,
// as its CI runs it, so the stamp covers what CI checks and the suite runs once.
// `prefix` runs before each gate's command, as idle()'s does.
export function gates(extra: readonly string[], prefix: readonly string[] = []): Gate[] {
	const coverage = extra.includes("test:coverage")
	const base = coverage ? BASE.map((name) => (name === "test" ? "test:coverage" : name)) : BASE
	const rest = coverage ? extra.filter((name) => name !== "test:coverage") : extra
	return [...base, ...rest].map((name) => ({ name, command: [...prefix, "bun", "run", name] }))
}

// The command prefix that runs a gate at idle priority: ionice's idle class and nice 19, each where the machine has
// it. CI's runners are the job's alone, so there it is none.
export function idle(machine: { ci: boolean; has: (bin: string) => boolean }): string[] {
	if (machine.ci) return []
	return [...(machine.has("ionice") ? ["ionice", "-c", "3"] : []), ...(machine.has("nice") ? ["nice", "-n", "19"] : [])]
}

export type VerifyDeps = {
	gates: readonly Gate[]
	// The environment variables the repo's gates need, from `standards.env` in package.json; none when absent.
	env?: readonly string[]
	getenv?: (name: string) => string | undefined
	// package.json's `packageManager`, and the version of the bun running verify; a pin of another manager is not checked.
	packageManager?: string | undefined
	bunVersion?: string | undefined
	// The command's exit code, its output going to the terminal.
	run: (command: readonly string[]) => number
	git: (args: readonly string[]) => string
	stamp: (path: string, body: string) => void
	log: (line: string) => void
	now: () => Date
}

// 0 when every gate passed and HEAD is stamped, else the failing gate's code, or 1 for a dirty tree.
export function verify(deps: VerifyDeps): number {
	if (deps.git(["status", "--porcelain"]).trim() !== "") {
		deps.log("verify: the tree has uncommitted changes; commit them first, so the stamp names what the gates ran on")
		return 1
	}
	const unset = (deps.env ?? []).filter((name) => !deps.getenv?.(name)?.trim())
	if (unset.length > 0) {
		deps.log(
			`verify: ${unset.join(", ")} ${unset.length === 1 ? "is" : "are"} unset; the repo's gates need ${unset.length === 1 ? "it" : "them"} (standards.env in package.json). Set ${unset.length === 1 ? "it" : "them"} and run verify again`,
		)
		return 1
	}
	const pinned = /^bun@([^+]+)/.exec(deps.packageManager ?? "")?.[1]
	if (pinned !== undefined && pinned !== deps.bunVersion) {
		deps.log(
			`verify: this is bun ${deps.bunVersion}, and package.json's packageManager pins bun@${pinned}, the bun CI installs. Install it with \`mise install bun@${pinned}\` and run verify under it: \`mise exec bun@${pinned} -- bun run verify\``,
		)
		return 1
	}
	const sha = deps.git(["rev-parse", "HEAD"]).trim()
	for (const gate of deps.gates) {
		deps.log(`verify: ${gate.name}`)
		const code = deps.run(gate.command)
		if (code !== 0) {
			deps.log(`verify: ${gate.name} failed with exit code ${code}; no stamp for ${sha}`)
			return code
		}
	}
	const common = resolve(deps.git(["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim())
	deps.stamp(
		join(common, "standards-verified", sha),
		`${deps.now().toISOString()} ${deps.gates.map((gate) => gate.name).join(" ")}\n`,
	)
	deps.log(`verify: every gate passed; stamped ${sha}`)
	return 0
}

if (import.meta.main) {
	const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
		packageManager?: string
		standards?: { env?: string[]; gates?: string[] }
	}
	process.exit(
		verify({
			gates: gates(
				pkg.standards?.gates ?? [],
				idle({ ci: process.env["CI"] === "true", has: (bin) => spawnSync("which", [bin]).status === 0 }),
			),
			env: pkg.standards?.env ?? [],
			getenv: (name) => process.env[name],
			packageManager: pkg.packageManager,
			bunVersion: process.versions["bun"],
			run: (command) => spawnSync(command[0]!, command.slice(1), { stdio: "inherit" }).status ?? 1,
			git: (args) => spawnSync("git", args, { encoding: "utf8" }).stdout,
			stamp: (path, body) => {
				mkdirSync(dirname(path), { recursive: true })
				writeFileSync(path, body)
			},
			log: (line) => console.log(line),
			now: () => new Date(),
		}),
	)
}
