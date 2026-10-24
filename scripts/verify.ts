#!/usr/bin/env bun
// Managed by ~/Development/standards (files/scripts/verify.ts). Edit it there, then run `bun sync.ts`.
// `bun run verify`: every local gate in order, stopping at the first that fails with its exit code. The base four
// run in every repo; the repo's own gates follow, from `standards.gates` in package.json (set by sync from
// standards.json). On a clean tree where all pass, it stamps HEAD in `standards-verified/<sha>` of the repository's
// common git dir, which every worktree shares and nothing commits. pre-push requires the stamp of every pushed commit.
// A dirty tree is refused: the stamp would vouch for a commit the gates did not run on.
import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

export type Gate = { name: string; command: readonly string[] }

const BASE = ["fmt:check", "lint", "typecheck", "test"]

// A repo whose gates name `test:coverage` runs it in the base `test`'s place: the same suite with its thresholds,
// as its CI runs it, so the stamp covers what CI checks and the suite runs once.
export function gates(extra: readonly string[]): Gate[] {
	const coverage = extra.includes("test:coverage")
	const base = coverage ? BASE.map((name) => (name === "test" ? "test:coverage" : name)) : BASE
	const rest = coverage ? extra.filter((name) => name !== "test:coverage") : extra
	return [...base, ...rest].map((name) => ({ name, command: ["bun", "run", name] }))
}

export type VerifyDeps = {
	gates: readonly Gate[]
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
	const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { standards?: { gates?: string[] } }
	process.exit(
		verify({
			gates: gates(pkg.standards?.gates ?? []),
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
