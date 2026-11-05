/**
 * D6-8 of the area D round-six review: README's migrate commands run on the config they follow.
 * Its first config was a bun-sqlite database whose `environments` held only a D1 `prod`, so the
 * `apply` under it was refused for a missing `-e`, and its bun-sqlite provider was reachable by
 * none. Each config block is written into a project, with every file block between it and its
 * commands, and every command under it runs as written: `init` through the CLI, every other command
 * to the target it resolves, as the CLI resolves it, and a D1 target on to the binding its wrangler
 * config gives, as migrate-d1 finds and checks it.
 */
import fs from "node:fs"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { makeIo, projects, runCliWithFakes } from "../../src/cli/__fixtures__/io.ts"
import { parseArgs } from "../../src/cli/args.ts"
import { d1Config, wranglerReader } from "../../src/cli/migrate-d1.ts"
import { type MigrateTarget, resolveMigrateTarget } from "../../src/cli/migrate-target.ts"
import { wranglerBin } from "../../src/cli/__fixtures__/d1.ts"
import { type D1Target, resolveBinding } from "../../src/migrate/core/d1-binding.ts"

const README = fs.readFileSync(path.resolve(import.meta.dirname, "../../../../README.md"), "utf8")
const MIGRATIONS = README.slice(README.indexOf("\n## Migrations\n"), README.indexOf("\n## Query layer\n"))

type Block = { at: number; body: string; lang: string }
const BLOCKS: Block[] = [...MIGRATIONS.matchAll(/^```(\w+)\n([\s\S]*?)^```$/gm)].map((match) => ({
	at: match.index,
	body: match[2] as string,
	lang: match[1] as string,
}))
const CONFIGS = BLOCKS.filter((block) => block.body.startsWith("/* comb.migrate.config.ts */\n"))
const COMMANDS = BLOCKS.filter((block) => block.lang === "bash" && block.body.includes("comb migrate"))

/* inside the package, so a config's import of @lovrozagar/comb/migrate resolves to this comb */
const temp = projects(path.resolve(import.meta.dirname, "../.."))
afterEach(temp.clean)

/** The bash block that opens the section headed `heading` */
function opening(heading: string): Block {
	const at = MIGRATIONS.indexOf(`\n${heading}\n`)
	return COMMANDS.find((block) => block.at > at) as Block
}

/** The bash block directly after `config`, with only prose between them */
function after(config: Block): Block | undefined {
	return COMMANDS.find((block) => block.at > config.at && !CONFIGS.some((c) => c.at > config.at && c.at < block.at))
}

/** The file a block shows, by the name its first line gives (`/* name *\/` or `// name`), with that block's text */
function fileOf(block: Block): [string, string] | undefined {
	const name = /^(?:\/\* (\S+) \*\/|\/\/ (\S+))\n/.exec(block.body)
	return name === null ? undefined : [(name[1] ?? name[2]) as string, block.body]
}

/** The files a project copying the README holds for `config`: it, then each file block after it and before `commands` or the next config */
function filesOf(config: Block, commands: Block): Array<[string, string]> {
	const next = CONFIGS.find((block) => block.at > config.at)?.at ?? Infinity
	const between = BLOCKS.filter((block) => block.at > config.at && block.at < Math.min(commands.at, next))
	return [config, ...between].flatMap((block) => {
		const file = fileOf(block)
		return file === undefined ? [] : [file]
	})
}

/** Resolves when `target` is reached as its command reaches it: a D1 one through its wrangler config's binding */
async function reach(target: MigrateTarget, cwd: string): Promise<void> {
	if (target.provider.type !== "d1") return
	const request = {
		args: { options: {}, positionals: [] },
		db: target.database,
		io: makeIo(cwd),
		mode: "apply" as const,
	}
	const { config, dir } = d1Config(request, target)
	const read = await wranglerReader(wranglerBin())
	resolveBinding(read, {
		migrationsDir: dir,
		name: config.databaseName,
		wranglerConfig: config.wranglerConfig as string,
		wranglerEnv: config.wranglerEnv,
	} as D1Target)
}

/** What each of `commands`' lines gives, run in a project holding `config`'s files: 0, or its refusal */
async function run(config: Block, commands: Block): Promise<Array<[string, string | number]>> {
	const cwd = temp.make()
	for (const [name, body] of filesOf(config, commands)) fs.writeFileSync(path.join(cwd, name), body)
	const results: Array<[string, string | number]> = []
	for (const line of commands.body.split("\n").filter((text) => text.startsWith("bunx comb migrate "))) {
		const [command, ...rest] = line.slice("bunx comb ".length).split(" ")
		const verb = `${command} ${rest.shift()}` as "migrate apply"
		if (verb === ("migrate init" as string)) {
			const io = makeIo(cwd)
			const code = await runCliWithFakes(["migrate", "init", ...rest], io)
			results.push([line, code === 0 ? 0 : io.errors.join("\n")])
			continue
		}
		const { options, positionals } = parseArgs(rest, verb)
		const request = {
			cwd,
			db: positionals[0] as string,
			dir: options["dir"] as string | undefined,
			env: options["env"] as string | undefined,
			mode: verb === ("migrate diff" as string) ? ("diff" as const) : ("apply" as const),
		}
		const resolved = await resolveMigrateTarget(request)
			.then(async (target) => (target === undefined ? "no comb.migrate.config.ts" : reach(target, cwd).then(() => 0)))
			.catch((error: Error) => error.message)
		results.push([line, resolved])
	}
	return results
}

const passes = (results: Array<[string, string | number]>) => results.map(([line]) => [line, 0])

describe("README's migrate commands run on the config they follow (D6-8 of the area D round-six review)", () => {
	it("runs Diff and apply's commands, as written, on the section's first config, a plain bun-sqlite database", async () => {
		const [first] = CONFIGS as [Block]
		const results = await run(first, opening("### Diff and apply"))
		expect(results.length).toBeGreaterThanOrEqual(3)
		expect(results).toEqual(passes(results))
		expect(first.body).toContain('provider: { type: "bun-sqlite"')
		expect(first.body).not.toContain("environments")
	})

	it("runs the commands under the environments example, each naming its environment with -e", async () => {
		const environments = CONFIGS.find((config) => config.body.includes("environments:"))
		expect(environments?.body).toContain('type: "d1"')
		const commands = after(environments as Block)
		const lines = commands?.body.split("\n").filter((line) => line.startsWith("bunx comb migrate ")) ?? []
		expect(lines.length).toBeGreaterThanOrEqual(2)
		expect(lines.filter((line) => !/ -e \w+/.test(line))).toEqual([])
		const results = await run(environments as Block, commands as Block)
		expect(results).toEqual(passes(results))
	})

	it("leaves no migrate command block in the section that neither case runs", () => {
		const environments = CONFIGS.find((config) => config.body.includes("environments:")) as Block
		const covered = [opening("### Diff and apply"), after(environments)]
		expect(COMMANDS.filter((block) => !covered.includes(block))).toEqual([])
	})
})
