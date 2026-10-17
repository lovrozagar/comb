import { describe, expect, it } from "vitest"
import { OPTIONS, optionsHelp, parseArgs } from "./args.ts"
import { CliError } from "./output.ts"

describe("parseArgs", () => {
	it("reads positionals, value options in both forms, short aliases and flags", () => {
		expect(parseArgs(["core", "--dir", "m", "--file=one.sql", "-e", "prod", "-y", "--local"], "migrate apply")).toEqual(
			{
				options: { dir: "m", env: "prod", file: "one.sql", local: true, yes: true },
				positionals: ["core"],
			},
		)
		expect(parseArgs(["-"], "codegen").positionals).toEqual(["-"])
	})

	it.each([
		[["--nope"], "Unknown option: --nope"],
		[["-x"], "Unknown option: -x"],
		[["--yes"], "--yes does not apply to codegen"],
		[["-g"], "-g needs a value"],
		[["-g", "--tables"], "-g needs a value"],
		[["--tables="], "--tables needs a value"],
	])("refuses %j for codegen", (argv, message) => {
		expect(() => parseArgs(argv, "codegen")).toThrow(new CliError(message))
	})
})

describe("optionsHelp", () => {
	it("lists every declared option with its value, aliases and commands", () => {
		const lines = optionsHelp()
		expect(lines).toHaveLength(OPTIONS.length + 1)
		expect(lines.find((line) => line.includes("--generator"))).toMatch(
			/^ {2}-g, --generator <name> +Run one generator only \[codegen\]$/,
		)
		expect(lines.find((line) => line.includes("--local"))).toMatch(
			/^ {2}--local +.*\[migrate apply, migrate baseline\]$/,
		)
		expect(lines.at(-1)).toMatch(/^ {2}--help +Show this help$/)
	})
})
