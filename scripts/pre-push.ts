#!/usr/bin/env bun
// Managed by ~/Development/standards (files/scripts/pre-push.ts). Edit it there, then run `bun sync.ts`.
// pre-push: every pushed commit passed `bun run verify`, which stamps it in standards-verified/<sha> of the common git
// dir. Reads git's ref lines from stdin (lefthook: `use_stdin: true`); the remote name is the first argument. A branch
// deletion sends no commit. Never bypass it: a commit without a stamp gets `bun run verify`.
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

const git = (...args: string[]) => spawnSync("git", args, { encoding: "utf8" })
const remote = process.argv[2] ?? "origin"
const stamps = join(git("rev-parse", "--path-format=absolute", "--git-common-dir").stdout.trim(), "standards-verified")
const missing: string[] = []

for (const line of readFileSync(0, "utf8").split("\n")) {
	const [, localSha, , remoteSha] = line.trim().split(" ")
	if (!localSha || /^0+$/.test(localSha)) continue
	// A new branch, or a remote tip this clone does not have, sends what no remote-tracking branch already holds.
	const known = remoteSha && !/^0+$/.test(remoteSha) && git("cat-file", "-e", `${remoteSha}^{commit}`).status === 0
	const range = known ? [`${remoteSha}..${localSha}`] : [localSha, "--not", `--remotes=${remote}`]
	for (const sha of git("rev-list", ...range)
		.stdout.split("\n")
		.filter(Boolean)) {
		if (!existsSync(join(stamps, sha))) missing.push(sha)
	}
}

if (missing.length) {
	console.error(`\n✖ push refused: these commits have no verify stamp in ${stamps}\n`)
	for (const sha of missing) console.error(`  ${git("log", "-1", "--format=%h %s", sha).stdout.trim()}`)
	console.error(
		"\nCheck out each one on a clean tree and run `bun run verify`; it stamps the commit when every gate passes.\n",
	)
	process.exit(1)
}
