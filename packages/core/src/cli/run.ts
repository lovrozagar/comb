/**
 * Comb CLI: database codegen and the migration toolkit, run in process by `runCli(argv, io)`.
 * The binary (src/bin.ts) hands it the process's argv and IO.
 */
import { optionsHelp } from "./args.ts"
import { cmdCodegen } from "./codegen.ts"
import { cmdMigrate } from "./migrate.ts"
import { CliError, type CliIo } from "./output.ts"

const COMMANDS: ReadonlyArray<[string, string]> = [
	["codegen [db...]", "Run codegen for the databases in comb.config.ts (all, or those named)"],
	["codegen --tables <path>", "Direct mode: analyze one tables file and generate beside it"],
	["migrate init", "Create drizzle.config.ts, atlas.hcl and atlas-migrations/"],
	["migrate diff <db> [name]", "Diff the schema and write the next migration"],
	["migrate check <db>", "Check and approve the pending migrations, applying nothing"],
	["migrate apply <db>", "Apply pending migrations: approve drops, apply and record each at once"],
	["migrate baseline <db>", "Record the migrations a database already reflects as applied"],
	["migrate status <db>", "Show a Postgres or D1 database's applied and pending migrations"],
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

async function dispatch(argv: readonly string[], io: CliIo): Promise<void> {
	const [command, ...rest] = argv
	switch (command) {
		case undefined:
		case "help":
		case "--help":
			io.out(help())
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

/** Runs the comb CLI on `argv` (the arguments after the script) and returns its exit code. */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
	try {
		await dispatch(argv, io)
		return 0
	} catch (error) {
		io.err(error instanceof Error ? error.message : String(error))
		return error instanceof CliError ? error.exitCode : 1
	}
}
