/**
 * The command line: every option comb takes, declared once. The parser reads argv against these
 * declarations and the help prints them, so the two cannot disagree.
 */
import { CliError } from "./output.ts"

export type Command = "codegen" | "migrate apply" | "migrate baseline" | "migrate diff" | "migrate init"

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
		commands: ["migrate apply", "migrate baseline"],
		description: "Environment from comb.migrate.config.ts",
		long: "--env",
		short: "-e",
		value: "name",
	},
	{
		commands: ["migrate apply", "migrate baseline"],
		description: "Migrations directory (default: the config's, else ./atlas-migrations)",
		long: "--dir",
		value: "path",
	},
	{ commands: ["migrate apply"], description: "Apply this one migration file", long: "--file", value: "path" },
	{
		commands: ["migrate apply"],
		description: "Approve cautious changes without asking (not unsafe ones)",
		long: "--yes",
		short: "-y",
	},
	{
		commands: ["migrate apply", "migrate baseline"],
		description: "Without a migrate config: the local D1 (wrangler --local)",
		long: "--local",
	},
]

export type ParsedArgs = {
	positionals: string[]
	/** By long name without its dashes: the value, or true for a flag */
	options: Record<string, string | true>
}

const find = (flag: string) => OPTIONS.find((option) => option.long === flag || option.short === flag)

type Reading = { argv: readonly string[]; at: number; command: Command; parsed: ParsedArgs }

/** Read the option at `reading.at`; returns how many arguments it took */
function readOption(reading: Reading): number {
	const arg = reading.argv[reading.at] as string
	const [flag, inline] =
		arg.startsWith("--") && arg.includes("=")
			? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
			: [arg, undefined]
	const option = find(flag as string)
	if (!option) throw new CliError(`Unknown option: ${flag}`)
	if (!option.commands.includes(reading.command)) throw new CliError(`${flag} does not apply to ${reading.command}`)
	const name = option.long.slice(2)
	if (option.value === undefined) {
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

/** The OPTIONS section of the help, from the same declarations the parser reads, then --help */
export function optionsHelp(): string[] {
	const rows = OPTIONS.map((option) => [label(option), `${option.description} [${option.commands.join(", ")}]`])
	rows.push(["--help", "Show this help"])
	const width = Math.max(...rows.map(([name]) => (name as string).length)) + 2
	return rows.map(([name, text]) => `  ${(name as string).padEnd(width)}${text}`)
}
