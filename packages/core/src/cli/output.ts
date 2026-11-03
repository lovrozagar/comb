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
	cwd: string
	out(line: string): void
	err(line: string): void
	run?: Run | undefined
	/** How a Postgres baseline reads the database's catalog of what Atlas OSS does not compare, postgres.js unless a test fakes it (5.4b) */
	readPgObjects?: LiveRead | undefined
	/** How a Postgres baseline reads the history replayed on its dev database, comb's own (pg-replay.ts) unless a test fakes it (P5 of r19) */
	replayPgHistory?: typeof replayCatalog | undefined
	/** How a diff, baseline or adoption gives the dev database a non-public target schema, comb's own unless a test fakes it (P12) */
	readyPgDev?: ((target: { devUrl: string; schema: string }) => Promise<void>) | undefined
	/** How a migrate command finds an optional peer's entry before its first I/O, as comb and `bun` find it unless a test fakes it (K1 of r21) */
	locatePeer?: ((peer: string) => string) | undefined
	/** How a migrate command reads Atlas's version before its first I/O, `atlas version` through `run` unless a test fakes it (PA5 of r22) */
	readAtlasVersion?: (() => RunResult) | undefined
	/** Ask the person running the CLI a yes/no question; absent when nobody can answer (no TTY) */
	confirm?: ((question: string) => Promise<boolean>) | undefined
}

/** What `comb migrate check` reports once every pending migration is approved */
/** What a migrate apply, check or status found: the files it applied, or found applied, and those pending */
export type MigrateOutcome = { applied: string[]; pending: string[] }

export const checkPassed = (names: readonly string[]): string =>
	`\nCheck passed: ${names.length} pending${names.length > 0 ? `: ${names.join(", ")}` : ""}`

/** A failure the CLI reports as its message and exit code instead of a stack trace. */
export class CliError extends Error {
	readonly exitCode: number

	constructor(message: string, exitCode = 1) {
		super(message)
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

export type Terminal = {
	input: NodeJS.ReadableStream & { isTTY?: boolean | undefined }
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
 * The IO the comb binary runs with: the console, and questions on the terminal when there is one,
 * asked on stderr: a question is a human line, as every other --json sends there, so stdout stays
 * what the command prints (P4 of the 0.15.0 review)
 */
export function processIo({ input = process.stdin, output = process.stderr }: Partial<Terminal> = {}): CliIo {
	const terminal = { input, output }
	return {
		confirm: input.isTTY === true ? (question) => ask(terminal, question) : undefined,
		cwd: process.cwd(),
		err: (line) => console.error(line),
		out: (line) => console.log(line),
	}
}
