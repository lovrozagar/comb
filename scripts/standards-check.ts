#!/usr/bin/env bun
// Managed by ~/Development/standards (files/scripts/standards-check.ts). Edit it there, then run `bun sync.ts`.
// pre-push: this repo is in sync with ~/Development/standards and on the newest grunt, oxfmt, oxlint and lefthook.
// Where ~/Development/standards does not exist (CI, another machine), it says so and passes: the synced files are
// committed, so CI still runs exactly what was synced.
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const sync = join(homedir(), "Development/standards/sync.ts")
if (!existsSync(sync)) {
	console.log(`standards: ${sync} not found; drift check skipped`)
	process.exit(0)
}
process.exit(spawnSync("bun", [sync, "--check", "--here"], { stdio: "inherit" }).status ?? 1)
