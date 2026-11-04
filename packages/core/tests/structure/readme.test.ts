/**
 * The README is the manual an agent works from, so its code compiles and its links resolve. Each
 * ```ts block is one module, compiled against comb's real exports under the strict flags a
 * consumer may set, with the Workers and Node types loaded together as a Worker that runs codegen
 * would. A `<!-- ts-context … -->` comment right above a block declares what the snippet assumes
 * (a db, a table, a request) without showing it.
 */
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { type Command, needsOf, PEERS, type Provider } from "../../src/migrate/core/peer-needs.ts"
import { ATLAS_RANGE, type BinPeer } from "../../src/migrate/core/process.ts"

const ROOT = join(import.meta.dirname, "../..")
const REPO = join(ROOT, "../..")
const README = readFileSync(join(REPO, "README.md"), "utf8")
const TSC = join(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin", "tsc")
/* inside the package, so drizzle, zod and the Workers types resolve from its dependencies */
const WORK = join(ROOT, `.readme-typecheck-${process.pid}`)

afterAll(() => rmSync(WORK, { force: true, recursive: true }))

type Block = { code: string; context: string; line: number }

/** Every ```ts block with the line it starts on and the context comment right above it */
function blocks(text: string): Block[] {
	const pattern = /(?:<!-- ts-context\n([\s\S]*?)\n-->\n\n)?```ts\n([\s\S]*?)\n```/g
	return [...text.matchAll(pattern)].map((match) => ({
		code: match[2] as string,
		context: match[1] ?? "",
		line: text.slice(0, match.index + match[0].indexOf("```ts")).split("\n").length + 1,
	}))
}

const CONFIG = {
	compilerOptions: {
		allowImportingTsExtensions: true,
		exactOptionalPropertyTypes: true,
		module: "esnext",
		moduleResolution: "bundler",
		noEmit: true,
		noPropertyAccessFromIndexSignature: true,
		noUncheckedIndexedAccess: true,
		paths: { "@lovrozagar/comb": ["../src/index.ts"], "@lovrozagar/comb/*": ["../src/*"] },
		skipLibCheck: true,
		strict: true,
		target: "es2023",
		types: ["@cloudflare/workers-types", "node"],
	},
	include: ["*.ts"],
}

describe("README code", () => {
	it("compiles, every ts block, against the real exports", () => {
		const found = blocks(README)
		expect(found.length).toBeGreaterThan(15)
		mkdirSync(WORK, { recursive: true })
		for (const block of found) {
			writeFileSync(join(WORK, `readme_L${block.line}.ts`), `${block.context}\n${block.code}\nexport {}\n`)
		}
		writeFileSync(join(WORK, "tsconfig.json"), JSON.stringify(CONFIG))
		const tsc = spawnSync(process.execPath, [TSC, "-p", join(WORK, "tsconfig.json")], { encoding: "utf8" })
		expect(tsc.stdout.split("\n").filter((line) => line.includes("error TS"))).toEqual([])
		expect(tsc.status).toBe(0)
	}, 120_000)

	it("names each fence's language, and compiles every ts fence or says why its language is not compiled", () => {
		/* the languages left out, each with why; a fence of another language, or of none, fails here */
		const notCompiled: Record<string, string> = {
			bash: "shell commands",
			diff: "an upgrade step: a before and an after line of a caller's code, a fragment with no module around it",
			text: "program output, a directory tree, or the list query's syntax",
		}
		const fences: { indent: string; language: string; line: number }[] = []
		let open = false
		for (const [at, line] of README.split("\n").entries()) {
			const fence = /^( *)```(\S*)/.exec(line)
			if (fence === null) continue
			if (!open) fences.push({ indent: fence[1] as string, language: fence[2] as string, line: at + 1 })
			open = !open
		}
		expect(open).toBe(false)
		const ts = fences.filter(({ language }) => language === "ts")
		expect(fences.filter(({ language }) => language !== "ts" && !(language in notCompiled))).toEqual([])
		/* blocks() reads a fence at the line's start, so an indented ts fence would go uncompiled */
		expect(ts.filter(({ indent }) => indent !== "")).toEqual([])
		expect(blocks(README).map(({ line }) => line - 1)).toEqual(ts.map(({ line }) => line))
	})
})

/** GitHub's anchor for a heading */
const slug = (heading: string) =>
	heading
		.trim()
		.toLowerCase()
		.replace(/[^\w\- ]/g, "")
		.replaceAll(" ", "-")

describe("README package exports table", () => {
	it("lists every export subpath, and no other", () => {
		const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { exports: Record<string, string> }
		const subpaths = Object.keys(manifest.exports)
			.filter((key) => key !== "./package.json")
			.map((key) => (key === "." ? "@lovrozagar/comb" : `@lovrozagar/comb/${key.slice(2)}`))
		const section = README.slice(README.indexOf("## Package exports"), README.indexOf("## Repository layout"))
		const listed = [...section.matchAll(/^\| `(@lovrozagar\/comb[^`]*)`/gm)].map((match) => match[1])
		expect(listed.toSorted()).toEqual(subpaths.toSorted())
	})
})

/* K5 of r21: the table said postgres was for baseline alone, while check replays with it; the Required column is PEERS's */
// lookup-table: how the README names each provider
const NAMES: Record<string, string> = {
	"bun-sqlite": "bun:sqlite",
	d1: "D1",
	libsql: "libsql",
	postgres: "Postgres",
	turso: "Turso",
}
/** "`a`, `b` and `c`" */
const inWords = (words: readonly string[]): string =>
	words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`
/** What the Required cell of `peer` opens with: the commands that need it, on the providers they need it on */
function required(peer: string): string {
	const on = new Map<string, string[]>()
	for (const [provider, commands] of Object.entries(PEERS))
		for (const [command, needs = []] of Object.entries(commands))
			if (needs.some((need) => need.peer === peer && need.optional !== true))
				on.set(provider, [...(on.get(provider) ?? []), command])
	const sets = new Map<string, string[]>()
	for (const [provider, commands] of on) {
		const key = inWords(
			commands.toSorted().map((command, at) => (at === 0 ? `\`comb migrate ${command}\`` : `\`${command}\``)),
		)
		sets.set(key, [...(sets.get(key) ?? []), provider])
	}
	const phrases = [...sets].map(([commands, providers]) =>
		providers.length === Object.keys(PEERS).length
			? commands
			: `${commands} on ${inWords(providers.map((provider) => NAMES[provider] as string))}`,
	)
	return `only for ${phrases.join("; ")}`
}

describe("README peer dependencies table", () => {
	const ROWS = new Map(
		[...README.matchAll(/^\| `([^`]+)` +\|.*?(?<!\\)\| (.+?) +\|$/gm)].map((match) => [
			match[1] as string,
			match[2] as string,
		]),
	)
	const PEERED = [
		...new Set(
			Object.values(PEERS).flatMap((commands) =>
				Object.values(commands)
					.flat()
					.map((need) => need?.peer as string),
			),
		),
	]

	/* AD12 of the area D review: typescript joined peerDependencies with no row, and the rows checked only PEERS's */
	it("has a row for every peer package.json declares, at its range, and Atlas beside them", () => {
		const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
			peerDependencies: Record<string, string>
		}
		const start = README.indexOf("Peer dependencies:")
		const table = README.slice(start, README.indexOf("\n\n", README.indexOf("\n|", start)))
		const rows = [...table.matchAll(/^\| `([^`]+)` +\| `(.+?)` +\|/gm)].map(
			(match) => [match[1] as string, (match[2] as string).replaceAll("\\|", "|")] as const,
		)
		expect(Object.fromEntries(rows)).toEqual({ ...manifest.peerDependencies, atlas: ATLAS_RANGE })
	})

	it.each(PEERED)("opens %s's Required cell with what PEERS says needs it", (peer) => {
		expect(ROWS.get(peer)).toMatch(new RegExp(`^${required(peer).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[,:;. ]|$)`))
	})

	it.each(
		Object.values(PEERS)
			.flatMap((commands) => Object.entries(commands))
			.flatMap(([command, needs = []]) =>
				needs.filter((need) => need.optional === true).map((need) => [need.peer, command, need.why]),
			),
	)("names %s for %s, which runs without it, to %s", (peer, command, why) => {
		expect(ROWS.get(peer)).toContain(`\`${command}\` to ${why}`)
	})
})

/* D2-13 of the area D round-two review: the table named no tool for a D1 status, and nothing held it to PEERS */
describe("README external tools table", () => {
	// lookup-table: what a migrate command shells out to, Atlas and each bin peer; a new BinPeer fails the typecheck until it is listed
	const SHELLED: Record<"atlas" | BinPeer, true> = { atlas: true, "drizzle-kit": true, wrangler: true }
	const PROVIDERS = Object.keys(PEERS) as Provider[]
	const COMMANDS = [...new Set(Object.values(PEERS).flatMap((commands) => Object.keys(commands)))] as Command[]
	const START = README.indexOf("External tools the migration commands shell out to")

	/** The Needs cell of `command`: the tools every provider needs, then each other with the providers that need it */
	function needs(command: Command): string {
		const tools = Object.keys(SHELLED)
			.map((tool) => {
				const at = PROVIDERS.filter((provider) =>
					needsOf(command, provider, false).some((need) => need.peer === tool && need.optional !== true),
				)
				return [tool, at] as const
			})
			.filter(([, at]) => at.length > 0)
		const everywhere = tools.filter(([, at]) => at.length === PROVIDERS.length).map(([tool]) => `\`${tool}\``)
		const some = tools
			.filter(([, at]) => at.length < PROVIDERS.length)
			.map(([tool, at]) => `\`${tool}\` on ${inWords(at.map((provider) => NAMES[provider] as string))}`)
		return [...(everywhere.length > 0 ? [inWords(everywhere)] : []), ...some].join("; ")
	}

	it("gives every command a row naming what PEERS says it shells out to, on the providers it does", () => {
		const head = README.indexOf("\n|", START)
		const table = README.slice(head, README.indexOf("\n\n", head))
		const cells = [...table.matchAll(/^\| (`migrate .+?`) +\| (.+?) +\|$/gm)].flatMap((row) =>
			[...(row[1] as string).matchAll(/`migrate (\w+)`/g)].map((command) => [command[1] as string, row[2] as string]),
		)
		expect(Object.fromEntries(cells)).toEqual(Object.fromEntries(COMMANDS.map((command) => [command, needs(command)])))
	})

	it("states Atlas's range above it", () => {
		expect(README.slice(START, README.indexOf("\n", START))).toContain(`\`${ATLAS_RANGE}\``)
	})
})

/* D3-1 of the area D round-three review: item 8 promised a helper bounded by any wrangler `Env` compiles */
describe("README getHandle upgrade item", () => {
	const item = /^\d+\. \*\*Drop the type argument from `getHandle`\.\*\*.*$/m.exec(README)?.[0] ?? ""
	const helper = item.split(/(?<=\.) /).filter((sentence) => sentence.includes("helper"))

	it("bounds the generic helper it promises by an env whose SHARD_DB_0 is required", () => {
		expect(helper.find((sentence) => sentence.includes("`<E extends Env>(env: E)`"))).toMatch(/required/)
	})

	it("names wrangler's optional SHARD_DB_0 and the widening a helper bounded by it takes", () => {
		const optional = helper.find((sentence) => sentence.includes("`SHARD_DB_0?: D1Database`"))
		expect(optional).toContain("`const env: Env = given; router.getHandle(mapping, env)`")
	})
})

/* how item 2 names each provider */
const PROVIDER_NAMES: Readonly<Record<string, Provider>> = {
	D1: "d1",
	libsql: "libsql",
	Postgres: "postgres",
	Turso: "turso",
}

/** Whether `command` on `provider` loads a peer from the project: any it needs but Atlas, an optional one, and drizzle-kit, which comb spawns */
const loads = (provider: Provider, command: Command): boolean =>
	needsOf(command, provider, false).some(
		(need) => need.peer !== "atlas" && need.peer !== "drizzle-kit" && need.optional !== true,
	)

/* D4-6 of the area D round-four review: item 2 promises what a Bun single-file executable refuses */
describe("README peer install upgrade item", () => {
	const item =
		/^\d+\. \*\*Install `wrangler` and `drizzle-kit` in the project that runs comb\.\*\*.*$/m.exec(README)?.[0] ?? ""
	const refused = item.split(/(?<=\.) /).find((sentence) => sentence.includes("are refused in such an executable"))

	it("says codegen's analyze and the D1 commands but diff are refused in a compiled executable, and why", () => {
		expect(item).toContain("an app compiled to one executable")
		expect(refused).toContain("Codegen's `analyze`")
		expect(refused).toContain("(`status`, `check`, `apply` and `baseline`)")
		expect(refused).toMatch(/cannot read the modules the executable embeds/)
		expect(refused).toMatch(/run them with bun or node/)
	})

	/* D5-2 follow-up: the commands item 2 says are refused are those whose peer table row loads a peer, drizzle-kit
	   alone being one comb only spawns (wrangler's module comb loads, through importBin) */
	it("names, per provider, exactly the commands its peer table row loads no peer for", () => {
		const commands = [...new Set(Object.values(PEERS).flatMap((row) => Object.keys(row)))].sort() as Command[]
		const expected = Object.fromEntries(
			(Object.keys(PEERS) as Provider[])
				.filter((provider) => commands.some((command) => loads(provider, command)))
				.map((provider) => [provider, commands.filter((command) => !loads(provider, command))]),
		)
		const said: Record<string, string[]> = {}
		for (const [, list, but] of (refused ?? "").matchAll(/every ((?:[\w ,]+?)) command but `migrate (\w+)`/g))
			for (const name of (list as string).split(/, | and /)) said[PROVIDER_NAMES[name] ?? name] = [but as string]
		expect(said).toEqual(expected)
	})

	/* D5-2 of the area D round-five review: libsql, Turso and Postgres load their peers in process too */
	it("says the libsql, Turso and Postgres commands that load a peer are refused there, naming each peer", () => {
		expect(refused).toContain("every D1, libsql and Turso command but `migrate diff`")
		expect(refused).toContain("every Postgres command but `migrate status`")
		expect(refused).toContain("`loadPostgresParser`")
		for (const peer of ["wrangler", "@libsql/client", "libpg-query", "postgres"])
			expect(refused).toContain(`\`${peer}\``)
	})
})

/* K9 of r19: the table stopped at 0.14, and the three newest upgrade sections, read first, had no entry */
describe("README table of contents", () => {
	it("lists every section, in the order the README has them", () => {
		const prose = README.replaceAll(/^```[\s\S]*?^```$/gm, "")
		const sections = [...prose.matchAll(/^## (.+)$/gm)].map((match) => match[1] as string)
		const start = prose.indexOf("## Table of contents")
		const table = prose.slice(start, prose.indexOf("\n## ", start + 1))
		const listed = [...table.matchAll(/^- \[(.+)\]\(#(.+)\)$/gm)].map((match) => [match[1], match[2]])
		expect(listed).toEqual(
			sections.filter((heading) => heading !== "Table of contents").map((heading) => [heading, slug(heading)]),
		)
	})
})

describe("README links", () => {
	const links = [...README.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1] as string)
	const anchors = new Set([...README.matchAll(/^#{1,6} (.+)$/gm)].map((match) => slug(match[1] as string)))

	it("point at files that exist", () => {
		const local = links.filter((link) => !/^(?:https?:|mailto:|#)/.test(link))
		expect(local.length).toBeGreaterThan(0)
		expect(local.filter((link) => !existsSync(join(REPO, link.split("#")[0] as string)))).toEqual([])
	})

	it("point at headings that exist", () => {
		const inPage = links.filter((link) => link.startsWith("#")).map((link) => link.slice(1))
		expect(inPage.length).toBeGreaterThan(0)
		expect(inPage.filter((anchor) => !anchors.has(anchor))).toEqual([])
	})
})
