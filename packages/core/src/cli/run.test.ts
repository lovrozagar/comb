import { fixtureRoot } from "../codegen/__fixtures__/temp.ts"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
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

	it("is the help the README shows", async () => {
		const { help } = await import("./run.ts")
		const readme = readFileSync(join(import.meta.dirname, "../../../../README.md"), "utf8")
		expect(readme).toContain(`\`\`\`\n${help()}\n\`\`\``)
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
		const io = makeIo(dir, throwsText)
		expect(await runCli(["migrate", "diff"], io)).toBe(1)
		expect(io.errors).toEqual(["spawn exploded"])
		const thrown = makeIo(dir, throwsError)
		expect(await runCli(["migrate", "diff"], thrown)).toBe(1)
		expect(thrown.errors).toEqual(["bad runner"])
	})
})
