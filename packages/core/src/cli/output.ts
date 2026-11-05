/**
 * Where the CLI meets the process: the IO it writes and asks through, and the error it reports
 * as a message and an exit code. The only CLI module that touches the console.
 */
import type { Run, RunResult } from "../migrate/core/process.ts"
import type { LiveRead } from "../migrate/core/pg-live-types.ts"
import type { replayCatalog } from "../migrate/core/pg-replay.ts"

/** Where the CLI reads its working directory, writes its output, asks, and starts processes. */
export type CliIo = {
	/** The folder the CLI finds comb.config.ts, comb.migrate.config.ts and their files in, and resolves relative paths against */
	cwd: string
	/** Writes one line of a command's output, with no trailing newline; with --json, the command's one JSON object */
	out(line: string): void
	/** Writes one line of diagnostics, a refusal or a question's context, with no trailing newline; never part of --json output */
	err(line: string): void
	/** How the CLI starts a process (atlas, wrangler, drizzle-kit): comb's own, which spawns it and resolves with its exit code and output, unless the embedder supplies one */
	run?: Run | undefined
	/** Ask the person running the CLI a yes/no question; absent when nobody can answer (no TTY) */
	confirm?: ((question: string) => Promise<boolean>) | undefined
}

/**
 * What a command reads besides its io, comb's own unless its tests fake one: typed by
 * comb's internals, so they stay off the public CliIo and reach the CLI through runCliWith alone.
 */
export type CliDeps = {
	/** How a Postgres baseline reads the database's catalog of what Atlas OSS does not compare, postgres.js unless a test fakes it */
	readPgObjects?: LiveRead | undefined
	/** How a Postgres baseline reads the history replayed on its dev database, comb's own (pg-replay.ts) unless a test fakes it */
	replayPgHistory?: typeof replayCatalog | undefined
	/** How a diff, baseline or adoption gives the dev database a non-public target schema, comb's own unless a test fakes it */
	readyPgDev?: ((target: { devUrl: string; schema: string }) => Promise<void>) | undefined
	/** How a migrate command finds an optional peer's entry before its first I/O, as comb and `bun` find it unless a test fakes it */
	locatePeer?: ((peer: string) => string) | undefined
	/** How a migrate command reads Atlas's version before its first I/O, `atlas version` through `run` unless a test fakes it */
	readAtlasVersion?: (() => Promise<RunResult>) | undefined
}

/** The io a command runs on, with the seams runCliWith was given */
export type CliContext = CliIo & CliDeps

/** What `comb migrate check` reports once every pending migration is approved */
/** What a migrate apply, check or status found: the files it applied, or found applied, and those pending */
export type MigrateOutcome = { applied: string[]; pending: string[] }

export const checkPassed = (names: readonly string[]): string =>
	`\nCheck passed: ${names.length} pending${names.length > 0 ? `: ${names.join(", ")}` : ""}`

/** A failure the CLI reports as its message and exit code instead of a stack trace. */
export class CliError extends Error {
	/** The exit code the CLI ends with, 1 unless the constructor was given another */
	readonly exitCode: number

	/** A failure `runCli` prints as `message` on `err`, with no stack, and returns `exitCode` for; `options.cause` keeps the error it wraps */
	constructor(message: string, exitCode = 1, options?: ErrorOptions) {
		super(message, options)
		this.name = "CliError"
		this.exitCode = exitCode
	}
}

/** A failure a command already reported as its --json object: printed on stderr, never as a second object */
export class Reported extends CliError {
	constructor(error: unknown) {
		super(error instanceof Error ? error.message : String(error), error instanceof CliError ? error.exitCode : 1)
		this.name = "Reported"
	}
}

/** A request for help: the CLI prints `text` on out and exits 0, wherever in argv -h or --help came */
export class ShowHelp extends Error {
	readonly text: string

	constructor(text: string) {
		super(text)
		this.name = "ShowHelp"
		this.text = text
	}
}

/**
 * The streams `processIo` asks its yes/no questions on, typed as the calls comb makes on them, so a
 * consumer without Node's types reads them too: process.stdin and process.stderr, or any stream like them
 */
export type Terminal = {
	/** Where the answer is read, one line in cooked mode, as a terminal sends it */
	input: {
		/** True when `input` is a terminal; any other value leaves `CliIo.confirm` absent, so nothing is asked */
		isTTY?: boolean | undefined
		/** Takes each chunk of the answer, bytes or, once an encoding is set, a string */
		on(event: "data", listener: (chunk: string | Uint8Array) => void): unknown
		/** Called when the input ends; what it sent before is the answer */
		on(event: "end", listener: () => void): unknown
		/** Called when reading fails; the question rejects with `error` */
		on(event: "error", listener: (error: Error) => void): unknown
		/** Removes a data listener `on` added, once the question is answered, ended or failed */
		off(event: "data", listener: (chunk: string | Uint8Array) => void): unknown
		/** Removes an end listener `on` added, once the question is answered, ended or failed */
		off(event: "end", listener: () => void): unknown
		/** Removes an error listener `on` added, once the question is answered, ended or failed */
		off(event: "error", listener: (error: Error) => void): unknown
		/** Starts the chunks flowing, as a question is asked */
		resume(): unknown
		/** Stops them once the question is answered, so the input holds the process open no longer */
		pause(): unknown
	}
	/** Where the question is written; stderr by default, so a command's stdout stays its output */
	output: {
		/** Writes the question, `(y/N) ` after it, with no newline */
		write(chunk: string): unknown
	}
}

/** The first line `input` sends, or what it sent before it ended; it is paused and its listeners gone after */
function readLine(input: Terminal["input"]): Promise<string> {
	return new Promise((resolve, reject) => {
		const decoder = new TextDecoder()
		let text = ""
		const settle = (then: () => void): void => {
			input.off("data", data)
			input.off("end", end)
			input.off("error", error)
			input.pause()
			then()
		}
		const data = (chunk: string | Uint8Array): void => {
			text += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true })
			const newline = text.indexOf("\n")
			if (newline !== -1) settle(() => resolve(text.slice(0, newline)))
		}
		const end = (): void => settle(() => resolve(text + decoder.decode()))
		const error = (cause: Error): void => settle(() => reject(cause))
		input.on("data", data)
		input.on("end", end)
		input.on("error", error)
		input.resume()
	})
}

/** A yes/no question on the terminal; anything but y or yes is no, and so is an input that ends unanswered */
async function ask({ input, output }: Terminal, question: string): Promise<boolean> {
	output.write(`${question} (y/N) `)
	return /^y(?:es)?$/i.test((await readLine(input)).trim())
}

/**
 * The IO the comb binary runs with: the process's working directory, stdout for output, stderr for
 * diagnostics, and yes/no questions when `input` is a terminal. Questions are written to `output`,
 * stderr by default, so a command's stdout, its --json object among it, holds only what it prints.
 */
export function processIo({
	input = process.stdin,
	output = process.stderr,
}: { [K in keyof Terminal]?: Terminal[K] | undefined } = {}): CliIo {
	// Questions on stderr, so stdout stays a command's output
	const terminal = { input, output }
	return {
		confirm: input.isTTY === true ? (question) => ask(terminal, question) : undefined,
		cwd: process.cwd(),
		/* plain text on every runtime: Bun's console.error colors a line red on a terminal */
		err: (line) => void process.stderr.write(`${line}\n`),
		out: (line) => console.log(line),
	}
}
