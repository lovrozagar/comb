/**
 * AE14 of r22: the README says a Postgres file runs on a session of its own, at apply (one Atlas
 * call per file, atlas-apply-runs.ts) and at check (the replay's session per file, pg-replay.ts),
 * and the 0.21 upgrade notes tell a history that relied on an earlier file's SET to set it in each
 * file. Sibling: the SQLite paragraph's "the next file runs as it would alone" (S1 of r21).
 */
import { describe, expect, it } from "vitest"
import { README, section } from "./support/readme.ts"

const [docs = ""] = README.split("\n## Upgrading to 0.21\n")
const upgrade = section("Upgrading to 0.21")

/** The README paragraph, outside the upgrade notes, that holds `marker` */
function paragraph(marker: string): string {
	return docs.split("\n\n").find((text) => text.includes(marker)) ?? ""
}

describe("the README on a Postgres file's session (AE14 of r22)", () => {
	it("says apply gives each Postgres file an Atlas call and a session of its own, so a SET ends with it", () => {
		const apply = paragraph("`apply` works on a private copy of the migrations directory")
		expect(apply).toContain("one Atlas call per file, so each file runs on a session of its own")
		expect(apply).toMatch(/`SET`[^.]*`search_path`[^.]*`lock_timeout`[^.]*ends with the file/)
	})

	it("says check replays each Postgres file on a session of its own, as apply runs it", () => {
		expect(paragraph("`apply` works on a private copy of the migrations directory")).toContain(
			"`check` replays each file on a session of its own, as apply runs it",
		)
	})

	it("tells a 0.20 history that relied on an earlier file's SET to set it in each file", () => {
		const item = /^\d+\. \*\*On Postgres, set in each file the settings it relies on\.\*\*.*$/m.exec(upgrade)?.[0]
		expect(item).toContain("0.20 applied the pending files in one Atlas call, on one session")
		expect(item).toContain("**Fix:** a file that relied on a setting an earlier file made sets it itself")
	})
})
