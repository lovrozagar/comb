/**
 * The packed comb in a fresh project, twice: with its required peers only and with every peer.
 * Each subpath imports under bun and under tsx (plain Node does not run TypeScript from
 * node_modules); a Vite build and a wrangler bundle carry no tooling; tsc compiles every subpath
 * under strict flags in a bundler project and in a nodenext project.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { APP } from "./fixture.ts"
import { failures, IMPORT_ALL, ok, pack, run, type Stage, stage } from "./stage.ts"

let tarball: string
beforeAll(() => {
	tarball = pack()
})

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

	it.runIf(peers === "all").each(["tsconfig.bundler.json", "tsconfig.nodenext.json"])(
		"type-checks every subpath under strict flags (%s)",
		(config) => {
			const result = run(app.dir, "npx", ["tsc", "-p", config])
			expect(result.output.split("\n").filter((line) => line.includes("error TS"))).toEqual([])
			expect(result.status).toBe(0)
		},
	)
})
