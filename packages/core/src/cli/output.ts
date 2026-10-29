/**
 * Where the CLI meets the process: the IO it writes and asks through, and the error it reports
 * as a message and an exit code. The only CLI module that touches the console.
 */
import { createInterface } from "node:readline/promises"
import type { Run } from "../migrate/core/process.ts"
import type { LiveRead } from "../migrate/core/pg-live-types.ts"

/** Where the CLI reads its working directory, writes its output, asks, and starts processes. */
export type CliIo = {
	cwd: string
	out(line: string): void
	err(line: string): void
	run?: Run | undefined
	/** How a Postgres baseline reads the database's functions, triggers, views, sequences and policies, postgres.js unless a test fakes it (5.4b) */
	readPgObjects?: LiveRead | undefined
	/** How a diff, baseline or adoption gives the dev database a non-public target schema, comb's own unless a test fakes it (P12) */
	readyPgDev?: ((target: { devUrl: string; schema: string }) => Promise<void>) | undefined
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

/** A request for help: the CLI prints `text` on out and exits 0, wherever in argv -h or --help came */
export class ShowHelp extends Error {
	readonly text: string

	constructor(text: string) {
		super(text)
		this.name = "ShowHelp"
		this.text = text
	}
}

type Terminal = {
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
