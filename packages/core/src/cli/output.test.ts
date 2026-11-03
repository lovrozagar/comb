import { PassThrough } from "node:stream"
import { describe, expect, it, vi } from "vitest"
import { CliError, processIo, Reported } from "./output.ts"

describe("CliError", () => {
	it("carries its message and exit code, 1 unless given", () => {
		expect(new CliError("no")).toMatchObject({ exitCode: 1, message: "no", name: "CliError" })
		expect(new CliError("later", 2).exitCode).toBe(2)
	})
})

/** A terminal whose input answers `answer`, as a TTY or not */
function terminal(answer: string, isTTY: boolean) {
	const input = Object.assign(new PassThrough(), { isTTY })
	const output = new PassThrough()
	const written: string[] = []
	output.on("data", (chunk: Buffer) => written.push(chunk.toString()))
	queueMicrotask(() => input.write(`${answer}\n`))
	return { input, output, written }
}

describe("processIo", () => {
	/* KC11 of r22b: Bun's console.error colors a line red on a terminal, so every --json progress line read as an error */
	it("writes out to the console and err as plain text to stderr, and works in the process's directory", () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
		try {
			const io = processIo()
			io.out("to out")
			io.err("to err")
			expect(io.cwd).toBe(process.cwd())
			expect(log).toHaveBeenCalledWith("to out")
			expect(stderr.mock.calls).toEqual([["to err\n"]])
			expect(error).not.toHaveBeenCalled()
		} finally {
			vi.restoreAllMocks()
		}
	})

	/* P4 of the 0.15.0 review: the question went to stdout, which --json promises is one JSON object */
	it("asks on stderr, a human line as every other, leaving stdout to what the command prints", async () => {
		const tty = terminal("y", true)
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
		try {
			const confirm = processIo({ input: tty.input }).confirm as (question: string) => Promise<boolean>
			expect(await confirm("Apply?")).toBe(true)
			expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain("Apply? (y/N) ")
			expect(stdout).not.toHaveBeenCalled()
		} finally {
			vi.restoreAllMocks()
		}
	})

	it("cannot ask anything without a terminal", () => {
		expect(processIo(terminal("y", false)).confirm).toBeUndefined()
	})

	it.each([
		["y", true],
		["YES", true],
		[" n ", false],
		["", false],
	])("on a terminal, answers %j as %s", async (answer, expected) => {
		const tty = terminal(answer, true)
		const confirm = processIo(tty).confirm as (question: string) => Promise<boolean>
		expect(await confirm("Drop it?")).toBe(expected)
		expect(tty.written.join("")).toContain("Drop it? (y/N) ")
	})
})

/* K10 of r18: a failure a command already reported keeps its message and its exit code */
describe("Reported", () => {
	it("keeps what failed: a CliError's exit code, any other's 1, and a thrown non-error as text", () => {
		const reported = [new CliError("refused", 2), new Error("broke"), "plain"].map((error) => new Reported(error))
		expect(reported.map(({ exitCode, message, name }) => [message, exitCode, name])).toEqual([
			["refused", 2, "Reported"],
			["broke", 1, "Reported"],
			["plain", 1, "Reported"],
		])
	})
})
