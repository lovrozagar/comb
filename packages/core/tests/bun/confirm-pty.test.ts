/// <reference types="bun-types" />
/**
 * comb-5d's review of the reader that replaced readline in processIo's questions: a person at a
 * real terminal, a pty Bun opens, answers comb's bin. The terminal is in its cooked mode, so it
 * echoes and edits the line, a Ctrl-D ends the input and a Ctrl-C is the kernel's SIGINT, which
 * comb's signal path takes: the held steps run, then the process ends by the signal. A pipe is no
 * terminal, so `yes | comb migrate apply` is asked nothing and refused, as in 0.20.1.
 */
import { Database } from "bun:sqlite"
import { describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const SRC = path.join(import.meta.dir, "../../src")
const BIN = path.join(SRC, "bin.ts")
const PROMPT = "(y/N)"

/** A bun:sqlite project with `t` and `u` applied and a pending file dropping each one named in `drops` */
function project(drops: readonly string[]): { db: string; dir: string; tmp: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-confirm-"))
	const tmp = path.join(dir, "tmp")
	const migrations = path.join(dir, "m")
	const db = path.join(dir, "local.db")
	fs.mkdirSync(tmp)
	fs.mkdirSync(migrations)
	fs.writeFileSync(
		path.join(migrations, "0001_t.sql"),
		"CREATE TABLE t (id INTEGER PRIMARY KEY);\nCREATE TABLE u (id INTEGER PRIMARY KEY);\n",
	)
	fs.writeFileSync(
		path.join(dir, "comb.migrate.config.ts"),
		`export default { databases: { core: { migrationsDir: "./m", environments: {
	local: { name: "core", provider: { type: "bun-sqlite", path: ${JSON.stringify(db)} } },
} } } }\n`,
	)
	const hash = () => spawnSync("atlas", ["migrate", "hash", "--dir", `file://${migrations}`])
	hash()
	const applied = spawnSync(process.execPath, [BIN, "migrate", "apply", "core", "-e", "local", "--yes"], {
		cwd: dir,
		env: { ...process.env, TMPDIR: tmp },
	})
	if (applied.status !== 0) throw new Error(`the first apply failed: ${applied.stderr}`)
	drops.forEach((table, i) =>
		fs.writeFileSync(path.join(migrations, `000${i + 2}_drop_${table}.sql`), `DROP TABLE ${table};\n`),
	)
	hash()
	return { db, dir, tmp }
}

/** The tables `db` still has, of `t` and `u` */
function tables(db: string): string[] {
	const conn = new Database(db, { readonly: true })
	try {
		return conn
			.query<{ name: string }, []>(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('t', 'u') ORDER BY name",
			)
			.all()
			.map(({ name }) => name)
	} finally {
		conn.close()
	}
}

type Ended = { code: number | null; signal: string | null; screen: string }

/**
 * Runs `argv` on a pty and types each of `keys` once as many questions showed as keys typed before
 * it, and one more: a key per question, or one paste at the first
 */
async function typed(argv: readonly string[], keys: readonly string[], cwd: string, tmp: string): Promise<Ended> {
	let screen = ""
	const decoder = new TextDecoder()
	const proc = Bun.spawn([...argv], {
		cwd,
		env: { ...process.env, TMPDIR: tmp },
		terminal: {
			cols: 400,
			data(_terminal, bytes) {
				screen += decoder.decode(bytes, { stream: true })
			},
			rows: 50,
		},
	})
	const asked = () => screen.split(PROMPT).length - 1
	const killer = setTimeout(() => proc.kill("SIGKILL"), 30_000)
	for (const [k, key] of keys.entries()) {
		while (asked() < k + 1 && proc.exitCode === null) await Bun.sleep(10)
		/* the reader is listening once the question is written; the pause is the person's */
		await Bun.sleep(100)
		proc.terminal?.write(key)
	}
	await proc.exited
	clearTimeout(killer)
	return { code: proc.exitCode, screen, signal: proc.signalCode }
}

const scratches = (tmp: string) => fs.readdirSync(tmp).filter((name) => name.startsWith("comb-scratch-"))

/** `comb migrate apply` on a project dropping `drops`, answered by `keys` at a terminal */
async function apply(drops: readonly string[], keys: readonly string[]) {
	const { db, dir, tmp } = project(drops)
	try {
		const ended = await typed([process.execPath, BIN, "migrate", "apply", "core", "-e", "local"], keys, dir, tmp)
		return { ...ended, asked: ended.screen.split(PROMPT).length - 1, left: scratches(tmp), tables: tables(db) }
	} finally {
		fs.rmSync(dir, { force: true, recursive: true })
	}
}

describe("comb's question at a terminal (comb-5d's review of the reader that replaced readline)", () => {
	it("applies on y and Enter", async () => {
		const run = await apply(["t"], ["y\r"])
		expect({ asked: run.asked, code: run.code, tables: run.tables }).toEqual({ asked: 1, code: 0, tables: ["u"] })
	}, 60_000)

	it.each([
		["Enter alone", "\r"],
		["Ctrl-D, the input's end", "\x04"],
		["n and Enter", "n\r"],
	])(
		"refuses on %s and applies nothing",
		async (_, key) => {
			const run = await apply(["t"], [key])
			expect({ code: run.code, tables: run.tables }).toEqual({ code: 1, tables: ["t", "u"] })
			expect(run.screen).toContain("0002_drop_t.sql is unsafe")
		},
		60_000,
	)

	it("reads a line the terminal edited: n, Ctrl-U, yes and Enter applies", async () => {
		const run = await apply(["t"], ["n\x15yes\r"])
		expect({ code: run.code, tables: run.tables }).toEqual({ code: 0, tables: ["u"] })
	}, 60_000)

	it("answers each question from its own line of a paste, the second asked after the first", async () => {
		const both = await apply(["t", "u"], ["y\ry\r"])
		expect({ asked: both.asked, code: both.code, tables: both.tables }).toEqual({ asked: 2, code: 0, tables: [] })
		const second = await apply(["t", "u"], ["y\rn\r"])
		expect({ asked: second.asked, code: second.code, tables: second.tables }).toEqual({
			asked: 2,
			code: 1,
			tables: ["t", "u"],
		})
		expect(second.screen).toContain("0003_drop_u.sql is unsafe")
	}, 60_000)

	it("on Ctrl-C ends by SIGINT, leaving no scratch and nothing applied", async () => {
		const run = await apply(["t", "u"], ["y\r", "\x03"])
		expect({ asked: run.asked, left: run.left, signal: run.signal, tables: run.tables }).toEqual({
			asked: 2,
			left: [],
			signal: "SIGINT",
			tables: ["t", "u"],
		})
	}, 60_000)

	it("asks nothing through a pipe, so `yes | comb migrate apply` is refused, as in 0.20.1", () => {
		const { db, dir, tmp } = project(["t"])
		try {
			const piped = spawnSync(process.execPath, [BIN, "migrate", "apply", "core", "-e", "local"], {
				cwd: dir,
				env: { ...process.env, TMPDIR: tmp },
				input: "y\n".repeat(20),
			})
			expect({ code: piped.status, tables: tables(db) }).toEqual({ code: 1, tables: ["t", "u"] })
			expect(String(piped.stderr)).toContain("0002_drop_t.sql is unsafe")
			expect(String(piped.stderr)).toContain("confirm it on a terminal")
			expect(String(piped.stderr)).not.toContain(PROMPT)
		} finally {
			fs.rmSync(dir, { force: true, recursive: true })
		}
	}, 60_000)
})

describe("a Ctrl-C at the question takes comb's signal path", () => {
	/** A process that holds a cleanup step, as a run holds its scratch, and asks one question */
	function asker(dir: string): string {
		const script = path.join(dir, "ask.ts")
		fs.writeFileSync(
			script,
			`import fs from "node:fs"
import { hold } from ${JSON.stringify(path.join(SRC, "migrate/core/cleanup.ts"))}
import { processIo } from ${JSON.stringify(path.join(SRC, "cli/output.ts"))}
const release = hold((signal) => fs.writeSync(1, \`<<cleanup ran on \${signal}>>\\n\`))
const answer = await processIo().confirm?.("Drop it?")
release()
fs.writeSync(1, \`<<answer \${answer}>>\\n\`)
`,
		)
		return script
	}

	it.each([
		["Ctrl-C", "\x03", { code: null, marks: ["cleanup ran on SIGINT"], signal: "SIGINT" }],
		["Ctrl-D", "\x04", { code: 0, marks: ["answer false"], signal: null }],
		["y and Enter", "y\r", { code: 0, marks: ["answer true"], signal: null }],
	])(
		"on %s",
		async (_, key, expected) => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-confirm-"))
			try {
				const run = await typed([process.execPath, asker(dir)], [key], dir, dir)
				const marks = [...run.screen.matchAll(/<<([^>]*)>>/g)].map((mark) => mark[1])
				expect({ code: run.code, marks, signal: run.signal }).toEqual(expected)
			} finally {
				fs.rmSync(dir, { force: true, recursive: true })
			}
		},
		60_000,
	)
})
