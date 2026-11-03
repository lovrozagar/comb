/**
 * applyWithAtlas's check (M11): it reads, refusing what an apply would, and writes nothing; it
 * inspects a database with no history instead of Atlas's dry run, which would make Atlas's revisions
 * schema there; and it replays the history and the pending files on dev before any approval, so
 * Postgres decides what no database runs (P13 of r19), which an apply leaves to the apply itself.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { applyWithAtlas, type ApplyOptions } from "./atlas-apply.ts"
import { sumHashes } from "./atlas-dir.ts"
import type { Run } from "./process.ts"
import { type Fake, fakeAtlas, file, ok, revision, status } from "../../../tests/support/fake-atlas.ts"

let dir = ""
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "comb-atlas-check-"))
	writeFileSync(join(dir, "1_a.sql"), 'CREATE TABLE "a" ("id" int);\n')
	writeFileSync(join(dir, "2_b.sql"), 'DROP TABLE "a";\n')
	writeFileSync(join(dir, "atlas.sum"), "h1:x=\n1_a.sql h1:7=\n2_b.sql h1:7=\n")
})
afterEach(() => rmSync(dir, { force: true, recursive: true }))

const TARGET = { devUrl: "postgres://localhost/dev", lockTimeout: "5s", schema: "public", url: "postgres://db/app" }

/** A run of `exec` approving every file, with the files check's replay on dev was given, by name */
function options(exec: Run, more: Partial<ApplyOptions> = {}): ApplyOptions & { replayed: string[][] } {
	const replayed: string[][] = []
	return {
		approve: async () => ({ ok: true }),
		dir,
		exec,
		print: () => undefined,
		replayPending: async (_, { files }) => {
			replayed.push(files.map((each) => each.name))
		},
		replayed,
		sweepDev: async () => undefined,
		target: TARGET,
		...more,
	}
}

const PENDING = status({
	available: [file("1_a.sql"), file("2_b.sql")],
	pending: [file("1_a.sql"), file("2_b.sql")],
	status: "PENDING",
})

const APPLIED = ok(JSON.stringify({ applied: [{ Name: "1_a.sql" }, { Name: "2_b.sql" }], error: "", target: "2" }))

/** The Atlas commands a fake was asked to run, by their first two words */
const commands = (fake: Fake) => fake.calls.map((call) => call.args.slice(0, 2).join(" "))

describe("applyWithAtlas: a check (M11)", () => {
	it("inspects a database with no history instead of the dry run, and refuses one holding a table", async () => {
		const legacy = ok(JSON.stringify({ schemas: [{ name: "public", tables: [{ name: "legacy" }] }] }))
		const unclean = fakeAtlas({ inspect: legacy, status: PENDING })
		await expect(applyWithAtlas({ ...options(unclean), checkOnly: true })).rejects.toThrow("comb migrate baseline")
		const clean = fakeAtlas({ status: PENDING })
		expect(await applyWithAtlas({ ...options(clean), checkOnly: true })).toEqual(["1_a.sql", "2_b.sql"])
		expect(commands(clean)).not.toContain("migrate apply")
		expect(commands(clean)).toContain("schema inspect")
	})

	it("dry-runs a database with history, and inspects nothing", async () => {
		const fake = fakeAtlas({
			status: status({
				/* the hash atlas.sum records for the file, as Atlas recorded it */
				applied: [revision("1", { hash: sumHashes(dir).get("1_a.sql") })],
				available: [file("1_a.sql"), file("2_b.sql")],
				current: "1",
				pending: [file("2_b.sql")],
			}),
		})
		expect(await applyWithAtlas({ ...options(fake), checkOnly: true })).toEqual(["2_b.sql"])
		expect(commands(fake)).toContain("migrate apply")
		expect(commands(fake)).not.toContain("schema inspect")
	})

	/* P13 of r19: Postgres decides what no database runs, on check's replay of the history and the pending files */
	it("replays the history through the last pending file on dev before any approval, and an apply replays nothing", async () => {
		const checked = options(fakeAtlas({ status: PENDING }), {
			approve: async () => {
				expect(checked.replayed).toEqual([["1_a.sql", "2_b.sql"]])
				return { ok: true }
			},
		})
		await applyWithAtlas({ ...checked, checkOnly: true })
		const applied = options(fakeAtlas({ apply: APPLIED, status: PENDING }))
		await applyWithAtlas(applied)
		expect([checked.replayed, applied.replayed]).toEqual([[["1_a.sql", "2_b.sql"]], []])
	})
})
