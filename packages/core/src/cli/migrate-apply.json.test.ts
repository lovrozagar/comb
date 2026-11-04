/**
 * K20 of the 0.15.0 review: `--json` promises one JSON object on stdout, which a pipeline parses,
 * but an argv comb refused printed nothing there. Wherever `--json` is in argv, a refusal of the
 * argv itself is reported as that object too, its database null as none was read.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { makeIo, projects, runCliWithFakes } from "./__fixtures__/io.ts"

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
		/* K5 of r19: the inline spelling asks for the object as the bare one does */
		[["migrate", "status", "core", "--json=1"], "--json is a flag and takes no value; give it alone, or leave it out"],
		[["migrate", "status", "core", "--json="], "--json is a flag and takes no value; give it alone, or leave it out"],
	])("prints %j's refusal as the one JSON object on stdout, exiting 1", async (argv, refusal) => {
		const io = makeIo(temp.make())
		expect(await runCliWithFakes(argv, io)).toBe(1)
		expect(io.outputs.map((line) => JSON.parse(line) as unknown)).toEqual([
			{ applied: [], database: null, pending: [], refused: [refusal], unknown: [] },
		])
		expect(io.errors).toEqual([refusal])
	})

	it("prints the help, not JSON, for --help beside --json", async () => {
		const io = makeIo(temp.make())
		expect(await runCliWithFakes(["migrate", "status", "--json", "--help"], io)).toBe(0)
		expect(io.outputs.join("\n")).toMatch(/^Usage: comb migrate status/)
	})
})

/* D4-1 of the area D round-four review: an embedder's run may throw anything, and --json still reports it */
describe("migrate apply --json when the run throws a value that is not an Error", () => {
	it("reports the value in refused, as the one JSON object on stdout, exiting 1", async () => {
		const dir = temp.make()
		writeFileSync(
			join(dir, "comb.migrate.config.ts"),
			'export default { databases: { core: { migrationsDir: "m", name: "core", provider: { type: "libsql", url: "file:core.db" } } } }\n',
		)
		mkdirSync(join(dir, "m"))
		writeFileSync(join(dir, "m", "20260101000000_init.sql"), "CREATE TABLE post (id TEXT PRIMARY KEY);\n")
		writeFileSync(join(dir, "m", "atlas.sum"), "h1:x\n20260101000000_init.sql h1:y\n")
		const io = makeIo(dir, () => {
			throw "spawn exploded"
		})
		expect(await runCliWithFakes(["migrate", "apply", "core", "--json", "--yes"], io)).toBe(1)
		expect(io.outputs.map((line) => JSON.parse(line) as unknown)).toEqual([
			{ applied: [], database: "core", pending: [], refused: ["spawn exploded"], unknown: [] },
		])
		expect(io.errors).toEqual(["spawn exploded"])
	})
})
