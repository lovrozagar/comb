/**
 * How often an apply reads each Postgres file with Postgres's parser: once (M86). pgRead is the
 * parse, so it is counted by wrapping pg-split's own.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { applyWithAtlas } from "./atlas-apply.ts"
import { pgRead } from "./pg-split.ts"
import { fakeAtlas, file, status } from "../../../tests/support/fake-atlas.ts"

vi.mock("./pg-split.ts", async (importOriginal) => {
	const real = await importOriginal<typeof import("./pg-split.ts")>()
	return { ...real, pgRead: vi.fn(real.pgRead) }
})

const FILES = { "1_a.sql": 'CREATE TABLE "a" ("id" int);\n', "2_b.sql": 'ALTER TABLE "a" ADD COLUMN "b" int;\n' }
/** Atlas on a database with no history: every file pending */
const pending = Object.keys(FILES).map(file)
const atlas = fakeAtlas({ status: status({ available: pending, pending, status: "PENDING" }) })

let dir = ""
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "comb-atlas-reads-"))
	for (const [name, sql] of Object.entries(FILES)) writeFileSync(join(dir, name), sql)
	writeFileSync(join(dir, "atlas.sum"), "h1:x=\n1_a.sql h1:7=\n2_b.sql h1:7=\n")
	vi.mocked(pgRead).mockClear()
})
afterEach(() => rmSync(dir, { force: true, recursive: true }))

describe("applyWithAtlas: each pending file read once (M86)", () => {
	it("parses each file once, for the schema it leaves, its approval, drops and classification", async () => {
		const approved: string[][] = []
		const target = { devUrl: "postgres://localhost/dev", lockTimeout: "5s", schema: "public", url: "postgres://db/app" }
		await applyWithAtlas({
			approve: async (migration) => (approved.push(migration.statements), { ok: true }),
			checkOnly: true,
			dir,
			exec: atlas,
			print: () => {},
			target,
		})
		const files = vi
			.mocked(pgRead)
			.mock.calls.map(([sql]) => sql)
			.filter((sql) => sql !== "")
		expect(files).toEqual(Object.values(FILES))
		expect(approved).toEqual([['CREATE TABLE "a" ("id" int)'], ['ALTER TABLE "a" ADD COLUMN "b" int']])
	})
})
