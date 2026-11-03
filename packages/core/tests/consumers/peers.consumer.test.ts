/**
 * The packed comb in a fresh project, twice: with its required peers only and with every peer.
 * Each subpath imports under bun and under tsx (plain Node does not run TypeScript from
 * node_modules); a Vite build and a wrangler bundle carry no tooling; tsc compiles every subpath
 * under strict flags in a bundler project and in a nodenext project.
 */
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { Miniflare } from "miniflare"
import semver from "semver"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { PEERS } from "../../src/migrate/core/optional-peer.ts"
import { APP } from "./fixture.ts"
import {
	admittedOf,
	failures,
	IMPORT_ALL,
	installedVersion,
	ok,
	pack,
	peerRange,
	removePackage,
	REQUIRED_PEERS,
	run,
	type Stage,
	stage,
	stageLine,
} from "./stage.ts"

let tarball: string
beforeAll(() => {
	tarball = pack()
})

/** comb's files in a `tsc --listFiles` run: its declarations, and any of its source tsc loaded */
function combFiles(output: string): { declarations: string[]; source: string[] } {
	const files = output.split("\n").filter((line) => line.includes("node_modules/@lovrozagar/comb/"))
	return {
		declarations: files.filter((file) => file.endsWith(".d.ts")),
		source: files.filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts")),
	}
}

/* every subpath loads without ts-morph: codegen loads it in the child that reads the tables (codegen/runtime/load.ts) */
const NEEDS_TS_MORPH: string[] = []

describe.each([
	["required", NEEDS_TS_MORPH],
	["all", []],
] as const)("a consumer with %s peers", (peers, unavailable) => {
	let app: Stage
	beforeAll(() => {
		app = stage(tarball, peers, { ...APP, "import-all.mjs": IMPORT_ALL })
	})
	afterAll(() => app?.dispose())

	it.each([
		["bun", "bun", ["import-all.mjs"]],
		["tsx", "npx", ["tsx", "import-all.mjs"]],
	] as const)("imports every subpath under %s, but for those whose optional peer is absent", (_runtime, cmd, args) => {
		const output = ok(run(app.dir, cmd, args), `${cmd} import-all`)
		expect(failures(output)).toEqual([...unavailable])
		for (const line of output.split("\n").filter((l) => l.startsWith("FAIL "))) expect(line).toContain("ts-morph")
	})

	it("bundles with Vite, everything inlined, and no tooling in the bundle", () => {
		ok(run(app.dir, "npx", ["vite", "build", "--ssr", "src/worker.ts"]), "vite build")
		const files = readdirSync(join(app.dir, "dist-vite")).filter((file) => file.endsWith(".js"))
		expect(files.length).toBeGreaterThan(0)
		const bundle = files.map((file) => readFileSync(join(app.dir, "dist-vite", file), "utf8")).join("\n")
		/* comb's own code is in it, not left external */
		expect(bundle).toContain("invalid_cursor")
		expect(bundle).not.toMatch(/ts-morph|child_process|node:fs/)
	})

	it("bundles a Worker with wrangler", () => {
		expect(
			ok(run(app.dir, "npx", ["wrangler", "deploy", "--dry-run", "--outdir", "dist-worker"]), "wrangler"),
		).toContain("--dry-run: exiting now.")
	})

	/* 4.18: workerd refuses code from strings, so no comb schema may build any, nor bundle zod's compiler */
	it.runIf(peers === "required")(
		"runs on workerd, its schemas built and parsed with no code from a string",
		async () => {
			const args = [
				"wrangler",
				"deploy",
				"src/no-eval.ts",
				"--name",
				"no-eval",
				"--dry-run",
				"--outdir",
				"dist-no-eval",
			]
			ok(run(app.dir, "npx", args), "wrangler no-eval")
			const scriptPath = join(app.dir, "dist-no-eval", "no-eval.js")
			expect(readFileSync(scriptPath, "utf8")).not.toContain("ZodCompileUnsupportedError")
			/* a date every workerd binary takes, so the test does not follow miniflare's version */
			const worker = new Miniflare({
				compatibilityDate: "2025-01-01",
				modules: true,
				modulesRoot: dirname(scriptPath),
				scriptPath,
			})
			try {
				const response = await worker.dispatchFetch("http://comb.test/")
				expect(await response.json()).toEqual({ made: 0, parsed: [true, true, true] })
			} finally {
				await worker.dispose()
			}
		},
	)

	/* K2 of r17: a D1-only project, without the optional peers, type-checks its migrate config */
	it("type-checks a migrate config with no optional peer's types", () => {
		const result = run(app.dir, "npx", ["tsc", "-p", "tsconfig.migrate.json"])
		expect(result.output.split("\n").filter((line) => line.includes("error TS"))).toEqual([])
		expect(result.status).toBe(0)
	})

	/* K1 of r20: 0.18.0 gave 218 TS5097 here, one per `./x.ts` specifier of comb's source the Worker reached; the Worker's globals come from workers-types, an optional peer */
	it.runIf(peers === "all").each(["c3/tsconfig.json", "c3/tsconfig.strict.json"])(
		"type-checks a stock create-cloudflare Worker from comb's declarations alone (%s)",
		(config) => {
			const result = run(app.dir, "npx", ["tsc", "-p", config, "--listFiles"])
			expect(result.output.split("\n").filter((line) => line.includes("error TS"))).toEqual([])
			expect(result.status).toBe(0)
			expect(combFiles(result.output).source).toEqual([])
			expect(combFiles(result.output).declarations.length).toBeGreaterThan(0)
		},
	)

	it
		.runIf(peers === "all")
		.each([
			"tsconfig.bundler.json",
			"tsconfig.declarations.json",
			"tsconfig.nodenext.json",
			"tsconfig.worker.json",
			"tsconfig.worker-es2022.json",
			"tsconfig.worker-node.json",
			"tsconfig.worker-node-floor.json",
		])("type-checks every subpath under strict flags (%s)", (config) => {
		const result = run(app.dir, "npx", ["tsc", "-p", config])
		expect(result.output.split("\n").filter((line) => line.includes("error TS"))).toEqual([])
		expect(result.status).toBe(0)
	})

	/*
	 * An install that never ran prepack (a `file:` or link install of the tree, a git dependency) has
	 * no types/: tsc then takes the `default` condition, comb's source, as every release before 0.19
	 * did. Last in its describe, since it takes types/ out of the installed comb.
	 */
	it.runIf(peers === "all")("falls back to comb's source where its declarations were never emitted", () => {
		const packed = run(app.dir, "npx", ["tsc", "-p", "tsconfig.bundler.json", "--listFiles"])
		expect(combFiles(packed.output)).toMatchObject({ source: [] })
		rmSync(join(app.dir, "node_modules/@lovrozagar/comb/types"), { force: true, recursive: true })
		const unpacked = run(app.dir, "npx", ["tsc", "-p", "tsconfig.bundler.json", "--listFiles"])
		expect(unpacked.output.split("\n").filter((line) => line.includes("error TS"))).toEqual([])
		expect(unpacked.status).toBe(0)
		expect(combFiles(unpacked.output).declarations).toEqual([])
		expect(combFiles(unpacked.output).source.length).toBeGreaterThan(0)
	})
})

/* K8 of r20: every peer at the floor comb states installs, and comb type-checks against it */
describe("a consumer at comb's peer floors", () => {
	let app: Stage
	beforeAll(() => {
		app = stage(tarball, "all", APP, "floor")
	})
	afterAll(() => app?.dispose())

	it("type-checks every subpath under strict flags", () => {
		const result = run(app.dir, "npx", ["tsc", "-p", "tsconfig.bundler.json"])
		expect(result.output.split("\n").filter((line) => line.includes("error TS"))).toEqual([])
		expect(result.status).toBe(0)
	})
})

/* every tagged drizzle the range names, each by its exact version: 0.18 admitted the tagged rc.5, which failed the sharding types */
describe.each(admittedOf("drizzle-orm"))("a consumer on drizzle %s", (version) => {
	let app: Stage
	beforeAll(() => {
		app = stage(tarball, "all", APP, { pin: { "drizzle-kit": version, "drizzle-orm": version } })
	})
	afterAll(() => app?.dispose())

	it("type-checks every subpath under strict flags", () => {
		expect(installedVersion(app.dir, "drizzle-orm")).toBe(version)
		const result = run(app.dir, "npx", ["tsc", "-p", "tsconfig.bundler.json"])
		expect(result.output.split("\n").filter((line) => line.includes("error TS"))).toEqual([])
		expect(result.status).toBe(0)
	})
})

/* K7 of r20: a command whose optional peer is missing names the package, the range comb takes and the install */
describe("a consumer missing each optional peer", () => {
	const TABLES = `import { sqliteTable } from "drizzle-orm/sqlite-core"
import { c } from "@lovrozagar/comb/sqlite/columns"
export const post = sqliteTable("post", { id: c.id("id", { prefix: "post" }), title: c.text("title", { max: 200 }) })
`
	const configOf = (provider: string) =>
		`export default { databases: { core: { migrationsDir: "m", name: "core", provider: ${provider} } } }\n`
	const PG = JSON.stringify(process.env["COMB_TEST_PG_URL"])
	/* the preconditions each command meets before it needs the peer: tables, a drizzle and a wrangler config, a database file */
	const PROJECT = {
		"drizzle.config.ts": `export default { dialect: "sqlite", out: "./m", schema: "./post.tables.ts" }\n`,
		"m/20260101000000_init.sql": "CREATE TABLE a (id integer);\n",
		"post.tables.ts": TABLES,
		"wrangler.jsonc": JSON.stringify({
			compatibility_date: "2025-01-01",
			d1_databases: [{ binding: "CORE", database_id: "00000000-0000-0000-0000-000000000000", database_name: "core" }],
			name: "w",
		}),
		"x.db": "",
	}
	const CASES = [
		{ argv: ["codegen", "--tables", "post.tables.ts"], config: undefined, peer: "ts-morph" },
		{ argv: ["migrate", "diff", "core", "--dry-run"], config: undefined, peer: "drizzle-kit" },
		{
			argv: ["migrate", "check", "core", "--json"],
			config: configOf(`{ type: "libsql", url: "file:x.db" }`),
			peer: "@libsql/client",
		},
		{
			argv: ["migrate", "check", "core", "--json"],
			config: configOf(`{ type: "d1", databaseName: "CORE", local: true }`),
			peer: "wrangler",
		},
		{
			argv: ["migrate", "check", "core", "--json"],
			config: configOf(`{ type: "postgres", url: ${PG}, devUrl: ${PG} }`),
			peer: "libpg-query",
		},
	]
	let app: Stage
	beforeAll(() => {
		app = stage(tarball, "required")
		/* wrangler is one of the stage's tools; this consumer has none */
		removePackage(app.dir, "wrangler")
	})
	afterAll(() => app?.dispose())

	/** `files` written under `dir` */
	const write = (dir: string, files: Record<string, string>) => {
		for (const [file, text] of Object.entries(files)) {
			mkdirSync(dirname(join(dir, file)), { recursive: true })
			writeFileSync(join(dir, file), text)
		}
	}

	it.each(CASES)("comb $argv.0 $argv.1 without $peer names it, its range and the install", ({ argv, config, peer }) => {
		const dir = join(app.dir, "cases", peer.replace(/\W+/g, "-"))
		write(dir, { ...PROJECT, ...(config === undefined ? {} : { "comb.migrate.config.ts": config }) })
		ok(run(dir, "atlas", ["migrate", "hash", "--dir", `file://${join(dir, "m")}`]), "atlas migrate hash")
		const result = run(dir, join(app.dir, "node_modules", ".bin", "comb"), argv)
		expect(result.status).not.toBe(0)
		expect(result.output).toContain(`comb needs ${peer} (${peerRange(peer)}) to `)
		expect(result.output).toContain(`install "${peer}@${peerRange(peer)}"`)
		/* no resolver text from comb's own source, and no blame on the tables module */
		expect(result.output).not.toContain("@lovrozagar/comb/src/")
		expect(result.output).not.toContain("could not load")
		/* a refusal under --json is the one JSON object stdout promises (K5 of r19) */
		if (argv.includes("--json"))
			expect(result.output).toContain(`{"applied":[],"database":"core","pending":[],"refused":["comb needs ${peer} (`)
	})

	/* K1, P8 and S2 of r21: every (command, provider) PEERS gives peers to, with each absent and the endpoint dead */
	const DEAD = "postgres://u:p@127.0.0.1:9/core?sslmode=disable"
	// lookup-table: a provider of each type whose endpoint no call reaches
	const PROVIDERS: Record<string, string> = {
		"bun-sqlite": `{ type: "bun-sqlite", path: "x.db" }`,
		d1: `{ type: "d1", databaseName: "core" }`,
		libsql: `{ type: "libsql", url: "http://127.0.0.1:9" }`,
		postgres: `{ type: "postgres", url: "${DEAD}", devUrl: "${DEAD}" }`,
		turso: `{ type: "turso", apiToken: "tok", databaseName: "core", org: "org" }`,
	}
	const CELLS = Object.entries(PEERS).flatMap(([provider, commands]) =>
		Object.entries(commands).flatMap(([command, needs = []]) => {
			const required = needs.filter((need) => need.optional !== true)
			return required.length === 0 ? [] : [{ command, needs: required, provider }]
		}),
	)
	/* what records a call: atlas and wrangler on PATH, and fetch inside comb's process, each appending to the log */
	const RECORDERS = {
		"bin/atlas": `#!/bin/sh\necho "atlas $*" >> "$COMB_CALLS"\nexit 1\n`,
		"bin/wrangler": `#!/bin/sh\necho "wrangler $*" >> "$COMB_CALLS"\nexit 1\n`,
		"record-fetch.ts": `import { appendFileSync } from "node:fs"
globalThis.fetch = (async (input: string | URL | Request) => {
	appendFileSync(process.env["COMB_CALLS"] as string, \`fetch \${input instanceof Request ? input.url : String(input)}\\n\`)
	throw new TypeError("fetch failed")
}) as typeof fetch
`,
	}
	/** comb migrate `command` core in the cell for `provider`, as a project would run it, and every call it made */
	const runCell = (provider: string, command: string) => {
		const dir = join(app.dir, "cells", `${provider}-${command}`)
		write(dir, { ...PROJECT, ...RECORDERS, "comb.migrate.config.ts": configOf(PROVIDERS[provider] as string) })
		for (const bin of ["atlas", "wrangler"]) chmodSync(join(dir, "bin", bin), 0o755)
		const calls = join(dir, "calls.log")
		writeFileSync(calls, "")
		const comb = join(app.dir, "node_modules", ".bin", "comb")
		const result = run(dir, "bun", ["--preload", "./record-fetch.ts", comb, "migrate", command, "core"], {
			COMB_CALLS: calls,
			PATH: `${join(dir, "bin")}:${process.env["PATH"] ?? ""}`,
		})
		return { calls: readFileSync(calls, "utf8"), result }
	}

	it.each(CELLS)(
		"comb migrate $command on $provider names every peer it needs before any I/O",
		({ command, needs, provider }) => {
			const { calls, result } = runCell(provider, command)
			expect(result.status).not.toBe(0)
			const each = needs.map(({ peer, why }) => `${peer} (${peerRange(peer)}) to ${why}`)
			expect(result.output).toContain(`comb needs ${each.join(", and ")}; `)
			expect(result.output).toContain(`install ${needs.map(({ peer }) => `"${peer}@${peerRange(peer)}"`).join(" ")}`)
			/* no connect, fetch, spawn or Atlas call: the Turso create and token mint among them */
			expect(calls).toBe("")
			expect(result.output).not.toMatch(/ECONNREFUSED|dial tcp|fetch failed|Script not found/)
		},
	)

	/* K2 of r21: `bun add <peer>` took a major outside comb's range; the refusal's own words land inside it */
	it.each([
		["postgres", "baseline"],
		["turso", "check"],
	])("installs inside comb's range by the words the %s %s refusal gives", (provider, command) => {
		const { result } = runCell(provider, command)
		const words = /; install ((?:"[^"]+" ?)+)/.exec(result.output)?.[1] ?? ""
		const dir = join(app.dir, "installs", provider)
		write(dir, { "package.json": JSON.stringify({ name: "install", private: true }) })
		ok(run(dir, "sh", ["-c", `bun add ${words}`]), `bun add ${words}`)
		/* each word is "<peer>@<range>", and no range holds an @ */
		const installed = [...words.matchAll(/"([^"]+)"/g)].map(([, word]) => (word as string).replace(/@[^@]*$/, ""))
		expect(installed.length).toBeGreaterThan(0)
		for (const peer of installed)
			expect(semver.satisfies(installedVersion(dir, peer), peerRange(peer)), peer).toBe(true)
	})
})

/* K3 of r20: the README's own line installs each required peer inside comb's range */
describe("a consumer installed by the README's bun add line", () => {
	let app: Stage
	beforeAll(() => {
		const readme = readFileSync(join(import.meta.dirname, "../../../../README.md"), "utf8")
		const line = readme.split("\n").find((text) => text.startsWith("bun add "))
		if (line === undefined) throw new Error("the README has no bun add line")
		app = stageLine(tarball, line)
	})
	afterAll(() => app?.dispose())

	it.each(Object.entries(REQUIRED_PEERS))("installs %s inside comb's range %s", (name, range) => {
		expect(semver.satisfies(installedVersion(app.dir, name), range)).toBe(true)
	})
})
