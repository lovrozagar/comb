import { fixtureRoot } from "../codegen/__fixtures__/temp.ts"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ATLAS_RANGE, type Run } from "../migrate/core/process.ts"
import { makeIo, projects, writeTables } from "./__fixtures__/io.ts"

const temp = projects(fixtureRoot())
const project = temp.make
afterEach(temp.clean)

describe("cli module", () => {
	it("runs nothing when imported", async () => {
		const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never)
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
		try {
			const cli = await import("./run.ts")
			expect(typeof cli.runCli).toBe("function")
			await new Promise((resolve) => setTimeout(resolve, 10))
			expect(exit).not.toHaveBeenCalled()
			expect(log).not.toHaveBeenCalled()
			expect(error).not.toHaveBeenCalled()
		} finally {
			vi.restoreAllMocks()
		}
	})
})

describe("runCli", () => {
	it("prints help to out and returns 0", async () => {
		const { runCli } = await import("./run.ts")
		for (const argv of [[], ["help"], ["--help"]]) {
			const io = makeIo(project())
			expect(await runCli(argv, io)).toBe(0)
			expect(io.outputs.join("\n")).toContain("COMMANDS:")
			expect(io.errors).toEqual([])
		}
	})

	it("returns 0 when codegen or migrate succeeds", async () => {
		const { runCli } = await import("./run.ts")
		const dir = project()
		writeTables(dir)
		expect(await runCli(["codegen", "--tables", "db.core.tables.ts", "-g", "rows"], makeIo(dir))).toBe(0)
		expect(await runCli(["migrate", "init"], makeIo(dir))).toBe(0)
	})

	it("rejects an unknown command with usage on err and returns 1", async () => {
		const { runCli } = await import("./run.ts")
		const io = makeIo(project())
		expect(await runCli(["nope"], io)).toBe(1)
		expect(io.errors.join("\n")).toContain("Unknown command: nope")
		expect(io.errors.join("\n")).toContain("COMMANDS:")
		expect(io.outputs).toEqual([])
	})

	it("parses every option its help advertises", async () => {
		const { runCli } = await import("./run.ts")
		const dir = project()
		const help = makeIo(dir)
		await runCli(["--help"], help)
		const advertised = [...help.outputs.join("\n").matchAll(/(?:^|\s)(--?[a-z][\w-]*)/gm)].map((m) => m[1] as string)
		expect(advertised.length).toBeGreaterThan(5)
		for (const flag of new Set(advertised)) {
			if (flag === "--help" || flag === "-h" || flag === "--version") continue
			const io = makeIo(dir, () => ({ code: 1, stderr: "stop", stdout: "" }))
			await runCli(["migrate", "apply", "core", flag, "x"], io)
			await runCli(["codegen", flag, "x"], io)
			expect(io.errors.join("\n"), flag).not.toMatch(new RegExp(`Unknown option: ${flag}(\\s|$)`))
		}
	})

	/* KC9 of r22b: status serves bun:sqlite, libsql and Turso too, and the help said Postgres or D1 */
	it("says status shows any database's migrations, as the README's prose does", async () => {
		const { help } = await import("./run.ts")
		expect(help()).toContain("  migrate status <db>       Show a database's applied and pending migrations\n")
		const readme = readFileSync(join(import.meta.dirname, "../../../../README.md"), "utf8")
		expect(readme).toContain("`status` lists a database's applied and pending migrations.")
	})

	it("is the help the README shows", async () => {
		const { help } = await import("./run.ts")
		const readme = readFileSync(join(import.meta.dirname, "../../../../README.md"), "utf8")
		expect(readme).toContain(`\`\`\`text\n${help()}\n\`\`\``)
	})
})

/* P13 ⊃ K19 of the 0.15.0 review: -h, --version and a command's --help were refused, and a bare migrate exited 0 */
describe("runCli: help and version", () => {
	it.each([["-h"], ["--help"]])("prints the help on %j and returns 0", async (flag) => {
		const { runCli } = await import("./run.ts")
		const io = makeIo(project())
		expect(await runCli([flag], io)).toBe(0)
		expect(io.outputs.join("\n")).toContain("COMMANDS:")
	})

	it("prints the version on --version", async () => {
		const { runCli } = await import("./run.ts")
		const io = makeIo(project())
		const { version } = JSON.parse(readFileSync(join(import.meta.dirname, "../../package.json"), "utf8")) as {
			version: string
		}
		expect(await runCli(["--version"], io)).toBe(0)
		expect(io.outputs).toEqual([version])
	})

	it.each([
		[["migrate", "apply", "--help"], "Usage: comb migrate apply <database>"],
		[["migrate", "status", "core", "-h"], "Usage: comb migrate status <database>"],
		[["codegen", "--help"], "Usage: comb codegen [database...]"],
	])("prints %j's own usage and returns 0", async (argv, usage) => {
		const { runCli } = await import("./run.ts")
		const io = makeIo(project())
		expect(await runCli(argv, io)).toBe(0)
		expect(io.outputs.join("\n")).toContain(usage)
		expect(io.errors).toEqual([])
	})

	/* K2 of r19: a word after help or version was dropped, and the run exited 0 */
	it.each([
		[["help", "migrate"], "Usage: comb help"],
		[["-h", "extra"], "Usage: comb -h"],
		[["--help", "extra"], "Usage: comb --help"],
		[["--version", "extra"], "Usage: comb --version"],
		[["migrate", "help", "extra"], "Usage: comb migrate help"],
		[["migrate", "-h", "extra"], "Usage: comb migrate -h"],
		[["migrate", "--help", "extra"], "Usage: comb migrate --help"],
	])("refuses %j with its usage, returning 1", async (argv, usage) => {
		const { runCli } = await import("./run.ts")
		const io = makeIo(project())
		expect(await runCli(argv, io)).toBe(1)
		expect(io.errors).toEqual([usage])
		expect(io.outputs).toEqual([])
	})

	it("refuses a bare migrate with the migrate commands, returning 1", async () => {
		const { runCli } = await import("./run.ts")
		const io = makeIo(project())
		expect(await runCli(["migrate"], io)).toBe(1)
		expect(io.errors.join("\n")).toContain("migrate apply <db>")
	})
})

/* runners that fail the way a broken spawn would: with a thrown string, and a thrown Error */
const throwsText = () => {
	throw "spawn exploded"
}
const throwsError = () => {
	throw new TypeError("bad runner")
}

describe("runCli: failures", () => {
	it("reports a failure that is not a CliError as its message, with exit code 1", async () => {
		const { runCli } = await import("./run.ts")
		const dir = project()
		writeFileSync(join(dir, "drizzle.config.ts"), 'export default { dialect: "sqlite" }\n')
		const io = makeIo(dir, throwsText)
		expect(await runCli(["migrate", "diff", "core"], io)).toBe(1)
		expect(io.errors).toEqual(["spawn exploded"])
		const thrown = makeIo(dir, throwsError)
		expect(await runCli(["migrate", "diff", "core"], thrown)).toBe(1)
		expect(thrown.errors).toEqual(["bad runner"])
	})
})

/* r18 K10: one --json rule: wherever --json is in argv, a refusal is the one JSON object stdout promises */
describe("runCli with --json on a command that does not take it", () => {
	it.each([
		[["migrate", "diff", "core", "--json"], "--json does not apply to migrate diff"],
		[["codegen", "--json"], "--json does not apply to codegen"],
		[["migrate", "init", "--json"], "--json does not apply to migrate init"],
	])("prints %j's refusal as one JSON object, and exits 1", async (argv, refused) => {
		const { runCli } = await import("./run.ts")
		const io = makeIo(project())
		expect(await runCli(argv, io)).toBe(1)
		expect(io.outputs.map((line) => JSON.parse(line) as unknown)).toEqual([
			{ applied: [], database: null, pending: [], refused: [refused], unknown: [] },
		])
	})
})

/* a seam that fails the run it is read in */
const seam = (): never => {
	throw new Error("a seam was read")
}

/* KT7 of r22b: runCli takes the documented io alone; the seams comb's own tests fake reach the CLI only through runCliWith */
describe("runCli reads only the io it documents", () => {
	it("runs Atlas's version through run, not through a seam an io happens to carry", async () => {
		const calls: string[][] = []
		const run: Run = (cmd, args) => {
			calls.push([cmd, ...args])
			return { code: 127, stderr: "atlas: command not found", stdout: "" }
		}
		const dir = project()
		writeFileSync(join(dir, "drizzle.config.ts"), 'export default { dialect: "sqlite" }\n')
		const io = { ...makeIo(dir, run), readAtlasVersion: seam }
		const { runCli } = await import("./run.ts")
		expect(await runCli(["migrate", "diff", "core"], io)).toBe(1)
		expect(io.errors).toEqual([
			`comb needs atlas (${ATLAS_RANGE}) to hash, diff and apply migrations; install atlas from https://atlasgo.io/getting-started`,
		])
		expect(calls).toEqual([["atlas", "version"]])
	})
})
