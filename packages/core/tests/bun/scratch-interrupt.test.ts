/// <reference types="bun-types" />
/**
 * S2 of r22: a check stopped by SIGINT or SIGTERM mid-proof leaves no proof scratch. The CLI runs
 * under Bun on a bun:sqlite target, whose proof copy is a scratch file, with a temp directory of
 * its own; the signal goes to comb's pid alone, as a supervisor or a CI step timeout sends it, once
 * the scratch is there.
 */
import { describe, expect, it } from "bun:test"
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const BIN = path.join(import.meta.dir, "../../src/bin.ts")

/** A bun:sqlite project with `t` applied and 400 pending files, each adding a column to it */
function project(): { dir: string; tmp: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-interrupt-"))
	const tmp = path.join(dir, "tmp")
	const migrations = path.join(dir, "m")
	fs.mkdirSync(tmp)
	fs.mkdirSync(migrations)
	fs.writeFileSync(path.join(migrations, "0001_t.sql"), "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);\n")
	fs.writeFileSync(
		path.join(dir, "comb.migrate.config.ts"),
		`export default { databases: { core: { migrationsDir: "./m", environments: {
	local: { name: "core", provider: { type: "bun-sqlite", path: ${JSON.stringify(path.join(dir, "local.db"))} } },
} } } }\n`,
	)
	const hash = () => spawnSync("atlas", ["migrate", "hash", "--dir", `file://${migrations}`])
	hash()
	const applied = spawnSync(process.execPath, [BIN, "migrate", "apply", "core", "-e", "local", "--yes"], {
		cwd: dir,
		env: { ...process.env, TMPDIR: tmp },
	})
	if (applied.status !== 0) throw new Error(`the first apply failed: ${applied.stderr}`)
	for (let i = 2; i < 402; i++)
		fs.writeFileSync(
			path.join(migrations, `${String(i).padStart(4, "0")}_c${i}.sql`),
			`ALTER TABLE t ADD COLUMN c${i} TEXT;\n`,
		)
	hash()
	return { dir, tmp }
}

const scratches = (tmp: string) => fs.readdirSync(tmp).filter((name) => name.startsWith("comb-scratch-"))

describe("a check stopped mid-proof (S2 of r22; sibling: P2 of r21's replay cleanup)", () => {
	it.each([["SIGINT"], ["SIGTERM"]] as const)(
		"on %s leaves no proof scratch and ends by the signal",
		async (signal) => {
			const { dir, tmp } = project()
			try {
				const child = spawn(process.execPath, [BIN, "migrate", "check", "core", "-e", "local", "--yes"], {
					cwd: dir,
					env: { ...process.env, TMPDIR: tmp },
					stdio: "ignore",
				})
				const seen = { scratch: 0 }
				const poll = setInterval(() => {
					if (scratches(tmp).length === 0) return
					seen.scratch = scratches(tmp).length
					clearInterval(poll)
					child.kill(signal)
				}, 5)
				const ended = await new Promise<NodeJS.Signals | null>((resolve) => child.on("exit", (_, sig) => resolve(sig)))
				clearInterval(poll)
				expect({ ended, left: scratches(tmp), seen: seen.scratch }).toEqual({ ended: signal, left: [], seen: 1 })
			} finally {
				fs.rmSync(dir, { force: true, recursive: true })
			}
		},
		60_000,
	)
})
