/**
 * Regenerates __snapshots__/released-exports.json from a release's tarball on the npm registry, the
 * declarations its consumers' compilers read, with the members of each type its exports reach: `bun tests/structure/support/write-released-exports.ts <version>`.
 * Run it from this package after each release, so the next version's section is held to that release.
 */
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { releasedApiOf } from "./exports-of.ts"

const version = process.argv[2]
if (version === undefined) throw new Error("name the release's version, such as 0.20.1")
const response = await fetch(`https://registry.npmjs.org/@lovrozagar/comb/-/comb-${version}.tgz`)
if (!response.ok) throw new Error(`comb ${version}: the registry answered ${response.status}`)
/* unpacked inside the package, so the release's declarations resolve its dependencies */
const dir = mkdtempSync(join(import.meta.dirname, "../../..", ".tmp-released-"))
try {
	writeFileSync(join(dir, "comb.tgz"), new Uint8Array(await response.arrayBuffer()))
	const untar = spawnSync("tar", ["-xzf", join(dir, "comb.tgz"), "-C", dir], { encoding: "utf8" })
	if (untar.status !== 0) throw new Error(`tar exited ${untar.status}\n${untar.stderr}`)
	const { exports, members } = releasedApiOf(join(dir, "package"))
	const target = join(import.meta.dirname, "../__snapshots__/released-exports.json")
	writeFileSync(target, `${JSON.stringify({ exports, members, version }, null, "\t")}\n`)
} finally {
	rmSync(dir, { force: true, recursive: true })
}
