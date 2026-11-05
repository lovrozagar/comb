import { PassThrough } from "node:stream"
import { describe, expect, it, vi } from "vitest"
import { CliError, lineReader, processIo, Reported } from "./output.ts"

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

/** A terminal whose input sends `chunks`, then ends, fails with `error`, or stays open; `questions` are asked one after another */
async function answering(
	chunks: readonly (string | Uint8Array)[],
	{
		after = "open",
		encoding,
		questions = 1,
	}: { after?: "end" | Error | "open"; encoding?: BufferEncoding; questions?: number } = {},
) {
	const input = Object.assign(new PassThrough(), { isTTY: true })
	if (encoding !== undefined) input.setEncoding(encoding)
	const written: string[] = []
	const output = { write: (chunk: string) => written.push(chunk) }
	const confirm = processIo({ input, output }).confirm as (question: string) => Promise<boolean>
	const answers = (async () => {
		const settled: (boolean | unknown)[] = []
		for (let n = 1; n <= questions; n++) settled.push(await confirm(`Q${n}?`).catch((error: unknown) => error))
		return settled
	})()
	for (const chunk of chunks) {
		input.write(chunk)
		await new Promise((resolve) => setImmediate(resolve))
	}
	if (after === "end") input.end()
	else if (after instanceof Error) input.destroy(after)
	return { answers, input, written }
}

/* comb-5d's node-types finding: Terminal named NodeJS, which a consumer without @types/node reads as `any`;
   and its runtime review of the reader that replaced readline */
describe("a question on a terminal typed by what comb calls", () => {
	it("reads an answer split across chunks, as bytes or as strings", async () => {
		const bytes = new TextEncoder().encode("Yes\n")
		expect(await (await answering([bytes.slice(0, 2), bytes.slice(2)])).answers).toEqual([true])
		expect(await (await answering(["Y", "e", "s\n"])).answers).toEqual([true])
		expect(await (await answering(["Y", "e", "s\n"], { encoding: "utf8" })).answers).toEqual([true])
	})

	it("writes the question to output alone", async () => {
		const { answers, written } = await answering(["yes\n"])
		expect(await answers).toEqual([true])
		expect(written).toEqual(["Q1? (y/N) "])
	})

	it.each([
		["\\r\\n", ["y\r\n"]],
		["a lone \\r", ["y\r"]],
		["\\n", ["y\n"]],
	])("ends a line at %s, as readline does", async (_, chunks) => {
		expect(await (await answering(chunks)).answers).toEqual([true])
	})

	it("reads a \\r\\n split across chunks as one line end, not a second, empty answer", async () => {
		expect(await (await answering(["y\r", "\nn\n"], { questions: 2 })).answers).toEqual([true, false])
		expect(await (await answering(["y\r", "yes\r"], { questions: 2 })).answers).toEqual([true, true])
	})

	it.each([["y\nn\n"], ["y\r\nn\r\n"], ["y\rn\r"]])(
		"answers each question from its own line when one chunk carries several: %j",
		async (chunk) => {
			const { answers, written } = await answering([chunk], { questions: 2 })
			expect(await answers).toEqual([true, false])
			expect(written).toEqual(["Q1? (y/N) ", "Q2? (y/N) "])
		},
	)

	it("leaves the input paused, with none of its listeners, between questions", async () => {
		const { answers, input } = await answering(["n\nleft"])
		expect(await answers).toEqual([false])
		expect(input.isPaused()).toBe(true)
		expect(["data", "end", "error"].map((event) => input.listenerCount(event))).toEqual([0, 0, 0])
	})

	it("decodes a character whose bytes are split across chunks", async () => {
		const input = new PassThrough()
		const bytes = new TextEncoder().encode("é\nü\n")
		const next = lineReader(input)
		const first = next()
		for (const byte of bytes) {
			input.write(Uint8Array.of(byte))
			await new Promise((resolve) => setImmediate(resolve))
		}
		expect(await first).toBe("é")
		expect(await next()).toBe("ü")
	})
})

describe("a question once the terminal's input ended or failed", () => {
	it("answers no when the input ends, a line it left unended among it, and every question after at once", async () => {
		expect(await (await answering([], { after: "end" })).answers).toEqual([false])
		expect(await (await answering(["y"], { after: "end" })).answers).toEqual([false])
		expect(await (await answering(["y\n"], { after: "end", questions: 3 })).answers).toEqual([true, false, false])
	})

	it("rejects with the input's error, on this question and every one after", async () => {
		const broke = new Error("input broke")
		expect(await (await answering([], { after: broke, questions: 2 })).answers).toEqual([broke, broke])
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
