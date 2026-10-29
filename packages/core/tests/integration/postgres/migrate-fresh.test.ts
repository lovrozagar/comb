/**
 * S9 and K3 of the 0.15.0 review, with the real Atlas: `comb migrate init` makes an empty
 * migrations directory, with no atlas.sum, and `status` and `check` on it failed with a raw ENOENT.
 * It is an empty history: nothing applied, nothing pending.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { approveMigration } from "../../../src/migrate/core/approval.ts"
import { applyWithAtlas, statusWithAtlas } from "../../../src/migrate/core/atlas-apply.ts"
import type { ParsedMigration } from "../../../src/migrate/types.ts"
import { withScratchDb } from "../support/pg.ts"

let dir = ""
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "comb-pg-fresh-"))
})
afterEach(() => rmSync(dir, { force: true, recursive: true }))

const approve = (m: ParsedMigration) => approveMigration(m, { target: "core", yes: false })

/** The options applyWithAtlas and statusWithAtlas take for the database at `url`, collecting what they print */
function command(url: string) {
	const out: string[] = []
	const target = { devUrl: "postgres://comb-no-dev.invalid/dev", lockTimeout: "5s", schema: "public", url }
	return { approve, dir, out, print: (line: string) => out.push(line), target }
}

describe("migrate status and check on Postgres, before the first migration", () => {
	describe("with Atlas v1.3.0", () => {
		it("read the directory init made as an empty history", async () => {
			await withScratchDb(async (url) => {
				const status = command(url)
				expect(statusWithAtlas(status)).toEqual({ applied: [], pending: [] })
				expect(await applyWithAtlas({ ...command(url), checkOnly: true })).toEqual([])
			})
		}, 60_000)
	})
})
