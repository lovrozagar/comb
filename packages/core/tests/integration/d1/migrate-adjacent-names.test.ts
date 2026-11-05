/**
 * Through the real wrangler --local: `ALTER TABLE "users"DROP COLUMN email` drops the column as the
 * spelling with a space does. comb's reading rated it safe, and only the proof run's loss stood between
 * it and a table the proof cannot seed; check and apply now refuse the statement itself, and the column stays.
 */
import fs from "node:fs"
import { afterEach, describe, expect, it } from "vitest"
import { runCli } from "../../../src/cli/index.ts"
import { d1Column, d1Io, d1Project, wrangler, writeMigrations } from "../support/d1-project.ts"

const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { force: true, recursive: true })
})

describe("comb migrate check and apply on D1 --local, a DROP COLUMN written against its quoted table", () => {
	it("refuses the statement as unsafe, so the column keeps its values", async () => {
		const dir = d1Project({ "0000_init.sql": "CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT);" })
		dirs.push(dir)
		expect(await runCli(["migrate", "apply", "core", "--local"], d1Io(dir))).toBe(0)
		const insert = "--command=INSERT INTO users (email) VALUES ('a@b.c')"
		expect((await wrangler(dir)("wrangler", ["d1", "execute", "core", "--local", insert])).code).toBe(0)
		writeMigrations(dir, { "0001_drop.sql": 'ALTER TABLE "users"DROP COLUMN email;\n' })
		for (const args of [["check"], ["apply", "--yes"]]) {
			const io = d1Io(dir)
			expect(await runCli(["migrate", args[0] as string, "core", "--local", ...args.slice(1)], io)).toBe(1)
			expect(io.errors.join("\n")).toContain(
				'0001_drop.sql is unsafe (ALTER TABLE "users"DROP COLUMN email; proof run: loses',
			)
		}
		expect(await d1Column(dir, "SELECT email FROM users")).toEqual(["a@b.c"])
	}, 180_000)
})
