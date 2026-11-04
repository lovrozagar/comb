/**
 * A Postgres `check` for a test file: a migrations directory of its own for each test, and a dev and
 * a target scratch database held from the file's first test to its last. The replay rolls back on
 * dev, and a check of a target with no history writes nothing, so every check shares them.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach } from "vitest"
import { approveMigration } from "../../../src/migrate/core/approval.ts"
import { applyWithAtlas } from "../../../src/migrate/core/atlas-apply.ts"
import { hashDir } from "../../../src/migrate/core/atlas-dir.ts"
import { loadPostgresParser } from "../../../src/migrate/core/pg-parser.ts"
import { run } from "../../../src/migrate/core/process.ts"
import type { ParsedMigration } from "../../../src/migrate/types.ts"
import { withScratchDb } from "./pg.ts"

/** A scratch database held from the file's first test to its last: its URL, inside a test */
function heldScratchDb(): () => string {
	const held = { release: () => undefined as void, url: "" }
	let dropped: Promise<void> = Promise.resolve()
	beforeAll(
		() =>
			new Promise<void>((ready) => {
				dropped = withScratchDb(
					(url) =>
						new Promise<void>((release) => {
							Object.assign(held, { release, url })
							ready()
						}),
				)
			}),
	)
	afterAll(async () => {
		held.release()
		await dropped
	})
	return () => held.url
}

/** A directory of migrations for a check */
const tempDir = (): string => mkdtempSync(join(tmpdir(), "comb-pg-check-replay-"))

/** The options a check of `dir` against `target` takes, collecting what it prints in `out` */
const optionsOf = (dir: string, target: { devUrl: string; url: string }, out: string[]) => ({
	approve: (m: ParsedMigration) => approveMigration(m, { target: "core", yes: true }),
	dir,
	print: (line: string) => out.push(line),
	target: { ...target, lockTimeout: "5s", schema: "public" },
})

/** `one` then `two`, written in `dir` and hashed: a history of `one` with `two` pending, as check replays them */
async function filesIn(dir: string, one: string, two: string): Promise<void> {
	/* CREATE STATISTICS is a kind comb does not rate: the history's own approval lets it pass */
	writeFileSync(join(dir, "20260101000000_one.sql"), `-- comb:allow-unsafe: the test's history\n${one}`)
	writeFileSync(join(dir, "20260102000000_two.sql"), two)
	await hashDir(run, dir)
}

/** Why `ran` refused, or undefined when it passed */
const refusal = (ran: Promise<unknown>): Promise<string | undefined> =>
	ran.then(
		() => undefined,
		(error: Error) => error.message,
	)

/** The check harness: call once at a test file's top level */
function pgCheck() {
	const state = { dir: "" }
	beforeAll(loadPostgresParser)
	beforeEach(() => {
		state.dir = tempDir()
	})
	afterEach(() => rmSync(state.dir, { force: true, recursive: true }))
	const devUrl = heldScratchDb()
	const targetUrl = heldScratchDb()
	const options = (target: { devUrl: string; url: string }, out: string[], dir = state.dir) =>
		optionsOf(dir, target, out)
	const files = (one: string, two: string, dir = state.dir) => filesIn(dir, one, two)

	/** `one` then `two` checked on the shared target, replayed on `dev`: what check printed, or why it refused */
	async function checked(
		one: string,
		two: string,
		dev = devUrl(),
	): Promise<{ out: string[]; refused?: string | undefined }> {
		await files(one, two)
		const out: string[] = []
		const refused = await refusal(
			applyWithAtlas({ ...options({ devUrl: dev, url: targetUrl() }, out), checkOnly: true }),
		)
		return refused === undefined ? { out } : { out, refused }
	}

	/** `one` then `two` checked, then applied, on a fresh target replayed on devUrl: why each refused, or undefined; check's lines in `out` */
	const checkThenApply = (one: string, two: string, out: string[] = []) =>
		withScratchDb(async (url) => {
			await files(one, two)
			const tried = (checkOnly: boolean) =>
				refusal(applyWithAtlas({ ...options({ devUrl: devUrl(), url }, checkOnly ? out : []), checkOnly }))
			return { check: await tried(true), apply: await tried(false) }
		})

	return { checked, checkThenApply, devUrl, dir: () => state.dir, files, options, targetUrl }
}

/* a history's first table and a second, as most checks start */
const T =
	"CREATE TABLE t (id int PRIMARY KEY, v varchar(10), w int);\nCREATE TABLE u (id int PRIMARY KEY, v varchar(10));\n"

export { pgCheck, T, tempDir }
