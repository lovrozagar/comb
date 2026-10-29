/**
 * K20 of the 0.15.0 review: `--json` promises one JSON object on stdout, which a pipeline parses,
 * but an argv comb refused printed nothing there. Wherever `--json` is in argv, a refusal of the
 * argv itself is reported as that object too, its database null as none was read.
 */
import { afterEach, describe, expect, it } from "vitest"
import { makeIo, projects } from "./__fixtures__/io.ts"
import { runCli } from "./run.ts"

const temp = projects()
afterEach(temp.clean)

describe("migrate apply, check and status --json on an argv comb refuses", () => {
	it.each([
		[["migrate", "status", "core", "-e", "local", "--json", "--bogus"], "Unknown option: --bogus"],
		[
			["migrate", "status", "--json"],
			"Usage: comb migrate status <database> [-e <name>] [--dir <path>] [--local] [--json]",
		],
		[
			["migrate", "check", "core", "-e", "local", "--json", "--yes=1"],
			"--yes is a flag and takes no value; give it alone, or leave it out",
		],
		[["migrate", "baseline", "core", "--json"], "--json does not apply to migrate baseline"],
	])("prints %j's refusal as the one JSON object on stdout, exiting 1", async (argv, refusal) => {
		const io = makeIo(temp.make())
		expect(await runCli(argv, io)).toBe(1)
		expect(io.outputs.map((line) => JSON.parse(line) as unknown)).toEqual([
			{ applied: [], database: null, pending: [], refused: [refusal] },
		])
		expect(io.errors).toEqual([refusal])
	})

	it("prints the help, not JSON, for --help beside --json", async () => {
		const io = makeIo(temp.make())
		expect(await runCli(["migrate", "status", "--json", "--help"], io)).toBe(0)
		expect(io.outputs.join("\n")).toMatch(/^Usage: comb migrate status/)
	})
})
