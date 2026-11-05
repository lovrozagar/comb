/**
 * Regenerates __snapshots__/released-exports.json from a release's tarball on the npm registry, the
 * declarations its consumers' compilers read, with the members of each type its exports reach and the types its callables take: `bun tests/structure/support/write-released-exports.ts <version>`.
 * It also records the text of each API snapshot (__snapshots__/api) at the release's tag, by file, so
 * the check reads what the release declared without git: CI's checkout is shallow and has no tags. A
 * file the record lacks is a subpath the release did not have.
 * Run it from this package after each release, in a clone that has the tag, so the next version's
 * section is held to that release.
 */
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { releasedApiOf } from "./exports-of.ts"

const version = process.argv[2]
if (version === undefined) throw new Error("name the release's version, such as 0.20.1")

/** `git args` in this package's checkout, its stdout; a failure throws with git's stderr */
function git(...args: string[]): string {
	const shown = spawnSync("git", args, { cwd: import.meta.dirname, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
	if (shown.status !== 0) throw new Error(`git ${args.join(" ")} exited ${shown.status}\n${shown.stderr}`)
	return shown.stdout
}

const API = "packages/core/tests/structure/__snapshots__/api"
/* each API snapshot at the tag, by file name */
const snapshots = Object.fromEntries(
	git("ls-tree", "--full-tree", "--name-only", `v${version}`, `${API}/`)
		.split("\n")
		.filter((path) => path !== "")
		.sort()
		.map((path) => [path.slice(API.length + 1), git("show", `v${version}:${path}`)]),
)
const response = await fetch(`https://registry.npmjs.org/@lovrozagar/comb/-/comb-${version}.tgz`)
if (!response.ok) throw new Error(`comb ${version}: the registry answered ${response.status}`)
/* unpacked inside the package, so the release's declarations resolve its dependencies */
const dir = mkdtempSync(join(import.meta.dirname, "../../..", ".tmp-released-"))
try {
	writeFileSync(join(dir, "comb.tgz"), new Uint8Array(await response.arrayBuffer()))
	const untar = spawnSync("tar", ["-xzf", join(dir, "comb.tgz"), "-C", dir], { encoding: "utf8" })
	if (untar.status !== 0) throw new Error(`tar exited ${untar.status}\n${untar.stderr}`)
	const { exports, inputs, members } = releasedApiOf(join(dir, "package"))
	const target = join(import.meta.dirname, "../__snapshots__/released-exports.json")
	writeFileSync(target, `${JSON.stringify({ exports, inputs, members, snapshots, version }, null, "\t")}\n`)
} finally {
	rmSync(dir, { force: true, recursive: true })
}
