/**
 * The Postgres history against the snapshot (atlas-history.ts): an applied file edited since is
 * refused, in status, check and apply alike, since each reads the history through checkHistory.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { sqlFiles } from "./atlas-dir.ts"
import { type AtlasRevision, type AtlasStatus, checkHistory } from "./atlas-history.ts"

let dir = ""
/** `files` as the snapshot, its sum hashed as `h1:<name length>=` for each */
function snapshot(files: Record<string, string>): void {
	for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql)
	const lines = sqlFiles(dir).map((name) => `${name} h1:${name.length}=`)
	writeFileSync(join(dir, "atlas.sum"), `h1:x=\n${lines.join("\n")}\n`)
}
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "comb-atlas-history-"))
})
afterEach(() => rmSync(dir, { force: true, recursive: true }))

/** A revision Atlas recorded for `name`, its hash the sum's for that name unless `hash` says otherwise */
function applied(name: string, hash?: string): AtlasRevision {
	const version = name.split("_")[0] as string
	return { applied: 1, error: "", errorStmt: "", hash: hash ?? `${name.length}=`, total: 1, type: "applied", version }
}

const history = (revisions: AtlasRevision[]): AtlasStatus => ({
	applied: revisions,
	available: [],
	current: revisions.at(-1)?.version ?? "",
	error: "",
	pending: [],
	status: "OK",
})

describe("an applied file edited since", () => {
	/* M17 of the 0.12 round: as on SQLite, an applied file edited since is refused, not a warning */
	it("refuses an applied file that changed since, in status, check and apply", () => {
		snapshot({ "1_a.sql": "SELECT 1;\n" })
		expect(() => checkHistory(history([applied("1_a.sql", "other=")]), dir)).toThrow(
			/^1_a\.sql was applied, then edited: its hash is not the one Atlas recorded/,
		)
		expect(checkHistory(history([applied("1_a.sql")]), dir)).toBeUndefined()
	})
})
