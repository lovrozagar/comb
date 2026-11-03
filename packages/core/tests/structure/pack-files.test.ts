/**
 * HN1 of plan 21: the pack copies the files git commits at the repo's root, so a copy of the tree that is no
 * repo of its own, nested in one that ignores it, listed nothing and packed an empty copy, failing later on
 * a symlink into it. packFiles refuses such a root up front, naming it and the repository git found.
 */
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { packFiles } from "../consumers/stage.ts"

const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

/** A git repository under the OS temp dir that ignores `copy/` */
function repo(): string {
	const dir = mkdtempSync(join(tmpdir(), "comb-pack-files-"))
	dirs.push(dir)
	spawnSync("git", ["init", "-q"], { cwd: dir })
	writeFileSync(join(dir, ".gitignore"), "copy/\n")
	return dir
}

describe("the pack's file list (HN1; sibling: the pack of a worktree)", () => {
	it("refuses a copy that is no repo of its own, nested in one, naming both", () => {
		const outer = repo()
		const copy = join(outer, "copy")
		mkdirSync(copy)
		writeFileSync(join(copy, "package.json"), "{}")
		expect(() => packFiles(copy)).toThrow(`${copy} is not the top of its git repository (${outer})`)
	})

	it("refuses a repository that lists none of the files a pack reads", () => {
		const root = repo()
		expect(() => packFiles(root)).toThrow(`git lists none of the files a pack reads at ${root}`)
	})

	it("lists the files git would commit at this checkout", () => {
		expect(packFiles(join(import.meta.dirname, "../../../.."))).toContain("packages/core/package.json")
	})
})
