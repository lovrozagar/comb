/**
 * `comb migrate` on D1 --local while another process holds the local D1 file's write lock, as
 * `wrangler dev` or a second comb does: wrangler sends each --command as one request, which
 * miniflare runs in one transaction that even a read opens for writing, so a held lock fails it at
 * once with SQLITE_BUSY. comb runs such a command again until the lock goes, 5 s at most.
 */
import fs from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import { runCli } from "../../../src/cli/index.ts"
import { localD1Path } from "../../../src/migrate/core/d1-binding.ts"
import type { Run } from "../../../src/migrate/core/process.ts"
import { LOCAL_BUSY } from "../../../src/migrate/drivers/d1-lock.ts"
import { d1Column, d1Io, d1Project, writeMigrations } from "../support/d1-project.ts"

const dirs: string[] = []
const held: DatabaseSync[] = []
afterEach(() => {
	for (const db of held.splice(0)) if (db.isOpen) db.close()
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { force: true, recursive: true })
})

const INIT = { "20260101000000_init.sql": "CREATE TABLE post (id TEXT PRIMARY KEY);" }
const ENTRY = { binding: "CORE", database_id: "00000000-0000-0000-0000-000000000000", database_name: "core" }
const LOCKED =
	"wrangler failed (exit 1): the local D1 database stayed locked by another process (wrangler dev, a wrangler command or a second comb migrate) for 5 s: let it finish and rerun"

/** A worker project on a local D1 with INIT applied, removed after the test */
async function applied(): Promise<string> {
	const dir = d1Project(INIT)
	dirs.push(dir)
	const apply = d1Io(dir)
	expect(await runCli(["migrate", "apply", "core", "--local"], apply), apply.errors.join("\n")).toBe(0)
	return dir
}

/** The project's local D1 file write-locked as another process holds it until the test ends, or until the release it returns */
function lock(dir: string): () => void {
	const db = new DatabaseSync(localD1Path(dir, ENTRY))
	held.push(db)
	db.exec("BEGIN IMMEDIATE")
	return () => db.isOpen && db.close()
}

/**
 * `run` with the project's file locked from the first wrangler run `takes` matches until a run comes back busy,
 * however late that run starts: a lock let go after a fixed time missed a first attempt a loaded machine
 * started after it (comb-5d, 2026-11-05). `busy` counts the runs the lock failed.
 */
function lockedUntilBusy(dir: string, run: Run, takes: (args: readonly string[]) => boolean) {
	const seen = { busy: 0 }
	let release: (() => void) | undefined
	let taken = false
	const locked: Run = async (cmd, args, options) => {
		if (!taken && takes(args)) {
			taken = true
			release = lock(dir)
		}
		const ran = await run(cmd, args, options)
		if (release !== undefined && LOCAL_BUSY.test(`${ran.stderr}\n${ran.stdout}`)) {
			seen.busy++
			release()
			release = undefined
		}
		return ran
	}
	return { run: locked, seen }
}

/** The --command of a wrangler run sending apply's hash intents, the batch before wrangler applies the file */
const intent = (args: readonly string[]) =>
	args.find(
		(arg) => arg.startsWith("--command=") && arg.includes("INSERT OR REPLACE INTO _comb_migration_hash_intents"),
	)

describe("comb migrate on D1 --local while another process holds the file's lock", () => {
	it("reads the history once the lock is let go within 5 s", async () => {
		const dir = await applied()
		const status = d1Io(dir)
		const { run, seen } = lockedUntilBusy(dir, status.run, (args) => args.includes("execute"))
		expect(await runCli(["migrate", "status", "core", "--local"], { ...status, run }), status.errors.join("\n")).toBe(0)
		expect([status.outputs, seen.busy]).toEqual([["Applied: 20260101000000_init.sql", "Pending: none"], 1])
	}, 120_000)

	it("refuses, naming the lock and no workerd stack, when it is held past 5 s", async () => {
		const dir = await applied()
		lock(dir)
		const status = d1Io(dir)
		expect(await runCli(["migrate", "status", "core", "--local"], status)).toBe(1)
		const said = status.errors.join("\n")
		expect([said.includes(LOCKED), /workerd|stack:/.test(said)]).toEqual([true, false])
	}, 120_000)

	it("runs the intent batch the lock failed again, and records the file once", async () => {
		const dir = await applied()
		writeMigrations(dir, { "20260102000000_tag.sql": "CREATE TABLE tag (id TEXT PRIMARY KEY);" })
		const apply = d1Io(dir)
		/* the lock is taken just as comb sends the intents, the batch before wrangler applies the file */
		const intents: string[] = []
		const { run, seen } = lockedUntilBusy(
			dir,
			(cmd, args, options) => {
				const command = intent(args)
				if (command !== undefined) intents.push(command)
				return apply.run(cmd, args, options)
			},
			(args) => intent(args) !== undefined,
		)
		expect(await runCli(["migrate", "apply", "core", "--local"], { ...apply, run }), apply.errors.join("\n")).toBe(0)
		expect(apply.outputs).toContain("\nDone: 1 applied")
		expect([seen.busy, intents.length, new Set(intents).size]).toEqual([1, 2, 1])
		const names = ["20260101000000_init.sql", "20260102000000_tag.sql"]
		expect(await d1Column(dir, "SELECT name FROM d1_migrations ORDER BY id")).toEqual(names)
		expect(await d1Column(dir, "SELECT name FROM _comb_migration_hashes ORDER BY name")).toEqual(names)
		expect(await d1Column(dir, "SELECT count(*) FROM _comb_migration_hash_intents")).toEqual([0])
	}, 180_000)
})
