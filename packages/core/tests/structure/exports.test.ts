/**
 * The package a consumer installs: every subpath it can import exists and ships, tests and
 * fixtures stay out of the tarball, installing it runs nothing, and each peer's floor is the
 * version comb is tested against, so no range claims a version the suite never ran.
 */
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { beforeAll, describe, expect, it } from "vitest"

const CORE = join(import.meta.dirname, "../..")
const ROOT = join(CORE, "../..")

type Manifest = {
	bin: Record<string, string>
	exports: Record<string, string>
	peerDependencies: Record<string, string>
	devDependencies: Record<string, string>
	scripts: Record<string, string>
}

const manifest = () => JSON.parse(readFileSync(join(CORE, "package.json"), "utf8")) as Manifest
const catalog = () =>
	(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { workspaces: { catalog: Record<string, string> } })
		.workspaces.catalog

type Pack = { files: Array<{ path: string }> }

const strip = (path: string) => path.replace(/^\.\//, "")

describe("package exports", () => {
	let packed: string[] = []

	beforeAll(() => {
		const npm = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: CORE, encoding: "utf8" })
		expect(npm.status).toBe(0)
		/* npm prints an array for a lone package and an object keyed by name inside a workspace */
		const report = JSON.parse(npm.stdout) as Pack[] | Record<string, Pack>
		const [pack] = Array.isArray(report) ? report : Object.values(report)
		packed = (pack?.files ?? []).map((file) => file.path)
	}, 60_000)

	it("every exports target and the bin exist and are in the tarball", () => {
		const { bin, exports } = manifest()
		const targets = [...Object.values(exports), ...Object.values(bin)].map(strip)
		expect(targets.filter((target) => !existsSync(join(CORE, target)))).toEqual([])
		expect(targets.filter((target) => !packed.includes(target))).toEqual([])
	})

	it("exports package.json, which tooling reads and node refuses unless it is exported", () => {
		expect(manifest().exports["./package.json"]).toBe("./package.json")
	})

	it("the bin is a bun script", () => {
		const bin = strip(manifest().bin.comb ?? "")
		expect(readFileSync(join(CORE, bin), "utf8").split("\n")[0]).toBe("#!/usr/bin/env bun")
	})

	it("ships no tests and no fixtures", () => {
		expect(packed.filter((path) => /\.test\.ts$|(?:^|\/)__fixtures__\//.test(path))).toEqual([])
		expect(packed.some((path) => path.startsWith("src/"))).toBe(true)
	})

	it("runs nothing on install", () => {
		const hooks = ["preinstall", "install", "postinstall", "prepare"]
		expect(Object.keys(manifest().scripts).filter((name) => hooks.includes(name))).toEqual([])
	})

	it("floors every peer at the version the suite runs", () => {
		const { devDependencies, peerDependencies } = manifest()
		const pins = catalog()
		const drift = Object.entries(peerDependencies).flatMap(([name, range]) => {
			const dev = devDependencies[name]
			const pin = dev === "catalog:" ? pins[name] : dev
			const floor = /^>=\s*([^\s<]+)/.exec(range)?.[1]
			return floor === pin ? [] : [`${name}: peer ${range}, tested ${pin ?? "never"}`]
		})
		expect(drift).toEqual([])
	})
})

describe("public entry points", () => {
	/* internals and CLI plumbing a consumer has no use for; `drizzle` would shadow drizzle-orm's */
	const INTERNAL = [
		"EMPTY_OBJ",
		"EMPTY_ARR",
		"sleep",
		"printMigrationSummary",
		"aggregateErrors",
		"drizzle",
		/* they handed back unvalidated requests: a filter or sort oracle on every column (S-M8) */
		"defineListQuery",
		"listQueryBaseSchema",
	]

	it("export none of comb's internals", async () => {
		const { exports } = manifest()
		const leaked: string[] = []
		for (const [subpath, target] of Object.entries(exports)) {
			if (!target.endsWith(".ts") || subpath === "./cli") continue
			const mod = (await import(join(CORE, target))) as Record<string, unknown>
			for (const name of INTERNAL) if (Object.hasOwn(mod, name)) leaked.push(`${subpath}: ${name}`)
		}
		expect(leaked).toEqual([])
	}, 60_000)
})
