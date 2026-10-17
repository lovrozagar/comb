/**
 * The release's wait for its npm tarball, run against stand-ins for curl and npm: it succeeds as
 * soon as the tarball resolves, accepts CDN lag once npm lists the version, and fails only when
 * the version never landed.
 */
import { spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

const SCRIPT = join(import.meta.dirname, "../../../../.github/scripts/npm-tarball-wait.sh")

const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

/** Run the script with a curl that succeeds from attempt `tarballAt` on and an npm that knows the version or not */
function wait(tarballAt: number | null, npmKnows: boolean) {
	const bin = mkdtempSync(join(tmpdir(), "comb-npm-wait-"))
	dirs.push(bin)
	const counter = join(bin, "count")
	writeFileSync(counter, "0")
	const stub = (name: string, body: string) => {
		writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`)
		chmodSync(join(bin, name), 0o755)
	}
	stub(
		"curl",
		`n=$(( $(cat ${counter}) + 1 )); echo $n > ${counter}; ${tarballAt === null ? "exit 22" : `[ $n -ge ${tarballAt} ] || exit 22`}`,
	)
	stub("npm", npmKnows ? "echo 0.5.0" : "exit 1")
	stub("sleep", "exit 0")
	return spawnSync("bash", [SCRIPT, "@lovrozagar/comb", "0.5.0"], {
		encoding: "utf8",
		env: { ...process.env, PATH: `${bin}:${process.env["PATH"]}`, WAIT_ATTEMPTS: "5", WAIT_SECONDS: "0" },
	})
}

describe("npm-tarball-wait.sh (plan 6.5)", () => {
	it("succeeds once the tarball resolves, after however many attempts", () => {
		const run = wait(3, false)
		expect(run.status).toBe(0)
		expect(run.stdout).toContain("is downloadable")
	})

	it("treats a listed version whose tarball never resolved as CDN lag: success with a warning", () => {
		const run = wait(null, true)
		expect(run.status).toBe(0)
		expect(run.stdout).toContain("::warning::")
	})

	it("fails when npm does not know the version", () => {
		const run = wait(null, false)
		expect(run.status).toBe(1)
		expect(run.stdout).toContain("did not land")
	})
})
