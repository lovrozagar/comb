/**
 * Comb CLI: database codegen and the migration toolkit, run in process by `runCli(argv, io)`.
 * The binary (src/bin.ts) hands it the process's argv and IO.
 */
import { optionsHelp, refuseFurther } from "./args.ts"
import { cmdCodegen } from "./codegen.ts"
import { cmdMigrate } from "./migrate.ts"
import { CliError, type CliContext, type CliDeps, type CliIo, Reported, ShowHelp } from "./output.ts"
import { version } from "./version.ts"

const COMMANDS: ReadonlyArray<[string, string]> = [
	["codegen [db...]", "Run codegen for the databases in comb.config.ts (all, or those named)"],
	["codegen --tables <path>", "Direct mode: analyze one tables file and generate beside it"],
	["migrate init", "Create drizzle.config.ts and atlas-migrations/"],
	["migrate diff <db> [name]", "Diff the schema and write the next migration"],
	["migrate check <db>", "Check and approve the pending migrations, applying nothing"],
	["migrate apply <db>", "Apply pending migrations: approve drops, apply and record each at once"],
	["migrate baseline <db>", "Record the migrations a database already reflects as applied"],
	["migrate status <db>", "Show a database's applied and pending migrations"],
]

/** The help, from the declarations the commands parse with */
export const help = (): string =>
	[
		"comb — database codegen + migration toolkit",
		"",
		"COMMANDS:",
		...COMMANDS.map(([usage, summary]) => `  ${usage.padEnd(26)}${summary}`),
		"",
		"OPTIONS:",
		...optionsHelp(),
	].join("\n")

async function dispatch(argv: readonly string[], io: CliContext): Promise<void> {
	const [command, ...rest] = argv
	switch (command) {
		case undefined:
			io.out(help())
			return
		case "help":
		case "-h":
		case "--help":
			refuseFurther(rest, command)
			io.out(help())
			return
		case "--version":
			refuseFurther(rest, command)
			io.out(version())
			return
		case "codegen":
			await cmdCodegen(rest, io)
			return
		case "migrate":
			await cmdMigrate(rest, io, help())
			return
		default:
			throw new CliError(`Unknown command: ${command}\n${help()}`)
	}
}

/** Whether `argv` asks for the one JSON object, in either spelling the parser reads as --json */
const asksJson = (argv: readonly string[]): boolean => argv.some((arg) => arg === "--json" || arg.startsWith("--json="))

/**
 * Runs the comb CLI on `argv` with `deps` in place of comb's own seams, for comb's tests.
 * Of `io` it reads the documented fields alone, so a seam an io carries is never read.
 */
export async function runCliWith(argv: readonly string[], io: CliIo, deps: CliDeps): Promise<number> {
	const context: CliContext = {
		...deps,
		confirm: io.confirm,
		cwd: io.cwd,
		err: (line) => io.err(line),
		out: (line) => io.out(line),
		run: io.run,
	}
	try {
		await dispatch(argv, context)
		return 0
	} catch (error) {
		if (error instanceof ShowHelp) {
			context.out(error.text)
			return 0
		}
		/* one --json rule for every command: a refusal no command reported is the one JSON object stdout promises */
		if (asksJson(argv) && error instanceof CliError && !(error instanceof Reported))
			context.out(JSON.stringify({ applied: [], database: null, pending: [], refused: [error.message], unknown: [] }))
		context.err(error instanceof Error ? error.message : String(error))
		return error instanceof CliError ? error.exitCode : 1
	}
}

/** Runs the comb CLI on `argv` (the arguments after the script) and returns its exit code. */
export function runCli(argv: readonly string[], io: CliIo): Promise<number> {
	return runCliWith(argv, io, {})
}
