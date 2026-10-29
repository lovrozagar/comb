/**
 * The command line: every option comb takes, declared once. The parser reads argv against these
 * declarations and the help prints them, so the two cannot disagree.
 */
import { CliError, ShowHelp } from "./output.ts"

export type Command =
	| "codegen"
	| "migrate apply"
	| "migrate baseline"
	| "migrate check"
	| "migrate diff"
	| "migrate init"
	| "migrate status"

export type OptionSpec = {
	/** The commands that take it */
	commands: readonly Command[]
	description: string
	long: `--${string}`
	short?: `-${string}` | undefined
	/** The value's placeholder; absent for a flag */
	value?: string | undefined
}

export const OPTIONS: readonly OptionSpec[] = [
	{ commands: ["codegen"], description: "Run one generator only", long: "--generator", short: "-g", value: "name" },
	{
		commands: ["codegen"],
		description: "Analyze this tables file directly, no comb.config.ts",
		long: "--tables",
		value: "path",
	},
	{
		commands: ["migrate apply", "migrate baseline", "migrate check", "migrate status"],
		description: "Environment from comb.migrate.config.ts",
		long: "--env",
		short: "-e",
		value: "name",
	},
	{
		commands: ["migrate apply", "migrate baseline", "migrate check", "migrate status"],
		description: "Migrations directory (default: the config's, else ./atlas-migrations)",
		long: "--dir",
		value: "path",
	},
	{
		commands: ["migrate init"],
		description: "The project's dialect: sqlite (default) or postgres",
		long: "--dialect",
		value: "name",
	},
	{
		commands: ["migrate diff"],
		description: "Write nothing: exit 1 printing the migration a diff would write, 0 in sync",
		long: "--dry-run",
	},
	{ commands: ["migrate apply"], description: "Apply this one migration file", long: "--file", value: "path" },
	{
		commands: ["migrate apply", "migrate check"],
		description: "Approve cautious changes without asking (not unsafe ones)",
		long: "--yes",
		short: "-y",
	},
	{
		commands: ["migrate apply", "migrate baseline", "migrate check", "migrate status"],
		description: "Without a migrate config: the local D1 (wrangler --local)",
		long: "--local",
	},
	{
		commands: ["migrate baseline"],
		description:
			"On D1: record the current hash of each applied file that has none (check the files against git first)",
		long: "--hashes",
	},
	{
		commands: ["migrate apply", "migrate check", "migrate status"],
		description: "Print one JSON object (database, applied, pending, refused) as the only stdout",
		long: "--json",
	},
]

export type ParsedArgs = {
	positionals: string[]
	/** By long name without its dashes: the value, or true for a flag */
	options: Record<string, string | true>
}

const find = (flag: string) => OPTIONS.find((option) => option.long === flag || option.short === flag)

type Reading = { argv: readonly string[]; at: number; command: Command; parsed: ParsedArgs }

/**
 * The option `flag` names, for the command `reading` reads: -h or --help shows its help, and one it
 * does not take, does not know, or was given already is refused (P13, C10 of the 0.15.0 review: a
 * second -g or --env replaced the first without a word)
 */
function optionOf(flag: string, reading: Reading): OptionSpec {
	if (flag === "-h" || flag === "--help") throw new ShowHelp(commandHelp(reading.command))
	const option = find(flag)
	if (!option) throw new CliError(`Unknown option: ${flag}`)
	if (!option.commands.includes(reading.command)) throw new CliError(`${flag} does not apply to ${reading.command}`)
	if (Object.hasOwn(reading.parsed.options, option.long.slice(2)))
		throw new CliError(`${option.long} is given twice; give it once`)
	return option
}

/** Read the option at `reading.at`; returns how many arguments it took */
function readOption(reading: Reading): number {
	const arg = reading.argv[reading.at] as string
	const [flag, inline] =
		arg.startsWith("--") && arg.includes("=")
			? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
			: [arg, undefined]
	const option = optionOf(flag as string, reading)
	const name = option.long.slice(2)
	if (option.value === undefined) {
		/* --yes=false would read as --yes, approving what its writer meant to refuse (P17) */
		if (inline !== undefined) throw new CliError(`${flag} is a flag and takes no value; give it alone, or leave it out`)
		reading.parsed.options[name] = true
		return 1
	}
	const next = reading.argv[reading.at + 1]
	const value = inline ?? next
	if (value === undefined || value === "" || (inline === undefined && value.startsWith("-"))) {
		throw new CliError(`${flag} needs a value`)
	}
	reading.parsed.options[name] = value
	return inline === undefined ? 2 : 1
}

/** `argv` read as `command`'s positionals and options; an option it does not take is an error */
export function parseArgs(argv: readonly string[], command: Command): ParsedArgs {
	const reading: Reading = { argv, at: 0, command, parsed: { options: {}, positionals: [] } }
	while (reading.at < argv.length) {
		const arg = argv[reading.at] as string
		if (arg.startsWith("-") && arg !== "-") {
			reading.at += readOption(reading)
		} else {
			reading.parsed.positionals.push(arg)
			reading.at++
		}
	}
	return reading.parsed
}

/** How the help names an option: its alias, long name and value placeholder */
const label = (option: OptionSpec) =>
	`${option.short ? `${option.short}, ` : ""}${option.long}${option.value ? ` <${option.value}>` : ""}`

/** Rows of a help's option table, each name padded to the widest */
const table = (rows: ReadonlyArray<readonly [string, string]>): string[] => {
	const width = Math.max(...rows.map(([name]) => name.length)) + 2
	return rows.map(([name, text]) => `  ${name.padEnd(width)}${text}`)
}

const HELP_ROW = ["-h, --help", "Show this help"] as const

/** The OPTIONS section of the help, from the same declarations the parser reads, then -h and --version */
export function optionsHelp(): string[] {
	return table([
		...OPTIONS.map((option) => [label(option), `${option.description} [${option.commands.join(", ")}]`] as const),
		HELP_ROW,
		["--version", "Print comb's version"],
	])
}

// lookup-table: what each command takes before its options
const POSITIONALS: Readonly<Record<Command, string>> = {
	codegen: "[database...]",
	"migrate apply": "<database>",
	"migrate baseline": "<database>",
	"migrate check": "<database>",
	"migrate diff": "<database> [name]",
	"migrate init": "",
	"migrate status": "<database>",
}

/** The options `command` takes, in the order OPTIONS declares them */
const optionsOf = (command: Command): OptionSpec[] => OPTIONS.filter((option) => option.commands.includes(command))

/** How a usage line names an option: its shortest spelling, and its value's placeholder */
const brief = (option: OptionSpec) => `[${option.short ?? option.long}${option.value ? ` <${option.value}>` : ""}]`

/** `command`'s usage line, built from what it takes (P13 of the 0.15.0 review) */
export function usageOf(command: Command): string {
	return ["Usage: comb", command, POSITIONALS[command], ...optionsOf(command).map(brief)]
		.filter((part) => part !== "")
		.join(" ")
}

/** `command`'s help: its usage, then each option it takes */
export function commandHelp(command: Command): string {
	const rows = optionsOf(command).map((option) => [label(option), option.description] as const)
	return [usageOf(command), "", "Options:", ...table([...rows, HELP_ROW])].join("\n")
}
