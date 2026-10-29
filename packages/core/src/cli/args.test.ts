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

/* P17 of the 0.14.1 review: --yes=false read as --yes, approving what its writer meant to refuse */
describe("parseArgs: a flag given a value", () => {
	it("refuses it, whatever the value, naming the flag", () => {
		for (const arg of ["--yes=false", "--yes=no", "--json=0", "--local=true"])
			expect(() => parseArgs(["core", arg], "migrate apply"), arg).toThrow(
				new CliError(`${arg.slice(0, arg.indexOf("="))} is a flag and takes no value; give it alone, or leave it out`),
			)
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
			/^ {2}--local +.*\[migrate apply, migrate baseline, migrate check, migrate status\]$/,
		)
		const migrating = /\[migrate apply, migrate baseline, migrate check, migrate status\]$/
		expect(lines.find((line) => line.includes("--env"))).toMatch(migrating)
		expect(lines.find((line) => line.includes("--dir"))).toMatch(migrating)
		expect(lines.at(-1)).toMatch(/^ {2}--help +Show this help$/)
	})
})
