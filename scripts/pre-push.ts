#!/usr/bin/env bun
// Managed by ~/Development/standards (files/scripts/pre-push.ts). Edit it there, then run `bun sync.ts`.
// pre-push: each pushed tip passed `bun run verify`, which stamps it in standards-verified/<sha> of the common git dir.
// The commits under a tip ride on its verify; CI runs the same gates on the push. Reads git's ref lines from stdin
// (lefthook: `use_stdin: true`). A branch deletion sends no commit. Never bypass it: a tip without a stamp gets
// `bun run verify`.
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

const git = (...args: string[]) => spawnSync("git", args, { encoding: "utf8" })
const stamps = join(git("rev-parse", "--path-format=absolute", "--git-common-dir").stdout.trim(), "standards-verified")
const missing: string[] = []

for (const line of readFileSync(0, "utf8").split("\n")) {
	const [, localSha] = line.trim().split(" ")
	if (!localSha || /^0+$/.test(localSha)) continue
	if (!existsSync(join(stamps, localSha))) missing.push(localSha)
}

if (missing.length) {
	console.error(`\n✖ push refused: these pushed tips have no verify stamp in ${stamps}\n`)
	for (const sha of missing) console.error(`  ${git("log", "-1", "--format=%h %s", sha).stdout.trim()}`)
	console.error(
		"\nCheck out each tip on a clean tree and run `bun run verify`; it stamps the commit when every gate passes.\n",
	)
	process.exit(1)
}
