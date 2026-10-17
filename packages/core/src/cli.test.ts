import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Run } from "./migrate/core/process.ts"

function makeIo(cwd: string, run?: Run) {
	const out: string[] = []
	const err: string[] = []
	return {
		cwd,
		err: (line: string) => err.push(line),
		errors: err,
		out: (line: string) => out.push(line),
		outputs: out,
		run,
	}
}

describe("cli module", () => {
	it("runs nothing when imported", async () => {
		const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never)
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
		try {
			const cli = await import("./cli.ts")
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
	let dir: string

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "comb-cli-"))
	})

	afterEach(() => {
		rmSync(dir, { force: true, recursive: true })
	})

	it("prints help to out and returns 0", async () => {
		const { runCli } = await import("./cli.ts")
		for (const argv of [[], ["help"], ["--help"]]) {
			const io = makeIo(dir)
			expect(await runCli(argv, io)).toBe(0)
			expect(io.outputs.join("\n")).toContain("COMMANDS:")
			expect(io.errors).toEqual([])
		}
	})

	it("rejects an unknown command with usage on err and returns 1", async () => {
		const { runCli } = await import("./cli.ts")
		const io = makeIo(dir)
		expect(await runCli(["nope"], io)).toBe(1)
		expect(io.errors.join("\n")).toContain("Unknown command: nope")
		expect(io.errors.join("\n")).toContain("COMMANDS:")
		expect(io.outputs).toEqual([])
	})

	it("reports a missing tables file in direct codegen mode, relative to cwd", async () => {
		const { runCli } = await import("./cli.ts")
		const io = makeIo(dir)
		expect(await runCli(["codegen", "--tables", "db.tables.ts"], io)).toBe(1)
		expect(io.errors).toEqual([`Tables file not found: ${join(dir, "db.tables.ts")}`])
	})

	it("reports a missing comb.config.ts in config mode", async () => {
		const { runCli } = await import("./cli.ts")
		const io = makeIo(dir)
		expect(await runCli(["codegen"], io)).toBe(1)
		expect(io.errors).toEqual(["No comb.config.ts found. Create one or use --tables <path> for direct mode."])
	})
})

describe("runCli: migrate", () => {
	let dir: string

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "comb-cli-"))
	})

	afterEach(() => {
		rmSync(dir, { force: true, recursive: true })
	})

	it("asks the injected runner for atlas before diffing", async () => {
		const { runCli } = await import("./cli.ts")
		const calls: string[][] = []
		const run: Run = (cmd, args) => {
			calls.push([cmd, ...args])
			return { code: 127, stderr: "atlas: command not found", stdout: "" }
		}
		const io = makeIo(dir, run)
		expect(await runCli(["migrate", "diff", "core"], io)).toBe(1)
		expect(io.errors).toEqual(["Atlas not found. Install: https://atlasgo.io/getting-started"])
		expect(calls).toEqual([["atlas", "version"]])
	})

	it("fails migrate diff when the config's FTS cannot be read, instead of diffing without it (S-12)", async () => {
		const { runCli } = await import("./cli.ts")
		writeFileSync(
			join(dir, "comb.config.ts"),
			'export default { databases: { core: { fts: { post: { columns: ["title"] } }, tables: "./missing.tables.ts" } } }\n',
		)
		const run: Run = (cmd, args) =>
			cmd === "bun" && args[0] === "drizzle-kit"
				? { code: 0, stderr: "", stdout: "CREATE TABLE post (title TEXT);" }
				: { code: 0, stderr: "", stdout: "" }
		const io = makeIo(dir, run)
		expect(await runCli(["migrate", "diff", "core"], io)).toBe(1)
		expect(io.errors.join("\n")).toMatch(/missing\.tables\.ts/)
	})

	it("refuses migrate diff for a database the config does not declare", async () => {
		const { runCli } = await import("./cli.ts")
		writeFileSync(join(dir, "comb.config.ts"), 'export default { databases: { core: { tables: "./t.ts" } } }\n')
		const run: Run = () => ({ code: 0, stderr: "", stdout: "" })
		const io = makeIo(dir, run)
		expect(await runCli(["migrate", "diff", "nope"], io)).toBe(1)
		expect(io.errors.join("\n")).toContain('comb.config.ts declares no database "nope"')
	})

	it("prints apply usage when the database name is missing, and a missing dir", async () => {
		const { runCli } = await import("./cli.ts")
		const usage = makeIo(dir)
		expect(await runCli(["migrate", "apply"], usage)).toBe(1)
		expect(usage.errors).toEqual(["Usage: comb migrate apply <d1-database-name> [--dir <path>] [--file <path>]"])
		const missing = makeIo(dir)
		expect(await runCli(["migrate", "baseline", "core", "--dir", "nowhere"], missing)).toBe(1)
		expect(missing.errors).toEqual([`Migrations dir not found: ${join(dir, "nowhere")}`])
	})

	it("rejects an unknown migrate command", async () => {
		const { runCli } = await import("./cli.ts")
		const io = makeIo(dir)
		expect(await runCli(["migrate", "nope"], io)).toBe(1)
		expect(io.errors).toEqual(["Unknown migrate command: nope"])
	})

	it("creates the migrate init files in cwd", async () => {
		const { runCli } = await import("./cli.ts")
		const io = makeIo(dir)
		expect(await runCli(["migrate", "init"], io)).toBe(0)
		expect(io.outputs).toEqual(["Created: drizzle.config.ts", "Created: atlas.hcl", "Created: atlas-migrations/"])
	})
})
