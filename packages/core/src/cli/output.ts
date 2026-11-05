/**
 * Where the CLI meets the process: the IO it writes and asks through, and the error it reports
 * as a message and an exit code. The only CLI module that touches the console.
 */
import { createInterface } from "node:readline/promises"
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
 * What a command reads besides its io, comb's own unless its tests fake one (KT7 of r22b): typed by
 * comb's internals, so they stay off the public CliIo and reach the CLI through runCliWith alone.
 */
export type CliDeps = {
	/** How a Postgres baseline reads the database's catalog of what Atlas OSS does not compare, postgres.js unless a test fakes it (5.4b) */
	readPgObjects?: LiveRead | undefined
	/** How a Postgres baseline reads the history replayed on its dev database, comb's own (pg-replay.ts) unless a test fakes it (P5 of r19) */
	replayPgHistory?: typeof replayCatalog | undefined
	/** How a diff, baseline or adoption gives the dev database a non-public target schema, comb's own unless a test fakes it (P12) */
	readyPgDev?: ((target: { devUrl: string; schema: string }) => Promise<void>) | undefined
	/** How a migrate command finds an optional peer's entry before its first I/O, as comb and `bun` find it unless a test fakes it (K1 of r21) */
	locatePeer?: ((peer: string) => string) | undefined
	/** How a migrate command reads Atlas's version before its first I/O, `atlas version` through `run` unless a test fakes it (PA5 of r22) */
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

/** A failure a command already reported as its --json object: printed on stderr, never as a second object (K10 of r18) */
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

/** The streams `processIo` asks its yes/no questions on */
export type Terminal = {
	/** Where the answer is read */
	input: NodeJS.ReadableStream & {
		/** True when `input` is a terminal; any other value leaves `CliIo.confirm` absent, so nothing is asked */
		isTTY?: boolean | undefined
	}
	/** Where the question is written; stderr by default, so a command's stdout stays its output */
	output: NodeJS.WritableStream
}

/** A yes/no question on the terminal; anything but y or yes is no */
async function ask(terminal: Terminal, question: string): Promise<boolean> {
	const prompt = createInterface({ input: terminal.input, output: terminal.output })
	try {
		const answer = await prompt.question(`${question} (y/N) `)
		return /^y(?:es)?$/i.test(answer.trim())
	} finally {
		prompt.close()
	}
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
	// P4 of the 0.15.0 review: questions on stderr, so stdout stays a command's output
	const terminal = { input, output }
	return {
		confirm: input.isTTY === true ? (question) => ask(terminal, question) : undefined,
		cwd: process.cwd(),
		/* plain text on every runtime: Bun's console.error colors a line red on a terminal (KC11 of r22b) */
		err: (line) => void process.stderr.write(`${line}\n`),
		out: (line) => console.log(line),
	}
}
