import { PassThrough } from "node:stream"
import { describe, expect, it, vi } from "vitest"
import { CliError, processIo } from "./output.ts"

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
	it("writes to the console and works in the process's directory", () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
		try {
			const io = processIo()
			io.out("to out")
			io.err("to err")
			expect(io.cwd).toBe(process.cwd())
			expect(log).toHaveBeenCalledWith("to out")
			expect(error).toHaveBeenCalledWith("to err")
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
