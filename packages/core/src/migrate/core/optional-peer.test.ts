import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import semver from "semver"
import { afterAll, describe, expect, it } from "vitest"
import {
	MissingPeerError,
	missingPeer,
	OPTIONAL_PEER_RANGES,
	type OptionalPeer,
	optionalPeer,
	binOf,
	importBin,
	projectBin,
	requirePeers,
	resolvePeer,
} from "./optional-peer.ts"
import { PEERS, WRANGLER } from "./peer-needs.ts"
import { ATLAS_RANGE, type RunResult } from "./process.ts"

/** The error Node's resolver gives for a package the project lacks */
const notFound = (name: string): Error =>
	Object.assign(new Error(`Cannot find package '${name}' imported from /p/x.js`), { code: "ERR_MODULE_NOT_FOUND" })

const ROOT = mkdtempSync(join(tmpdir(), "comb-optional-peer-"))
afterAll(() => rmSync(ROOT, { force: true, recursive: true }))

/** The entry of a package `name` at `version`, laid out as an install lays it, under a folder of its own */
function installed(name: string, version: string): string {
	const dir = join(ROOT, `${name.replace(/\W/g, "-")}-${version}`, "node_modules", name)
	mkdirSync(join(dir, "dist"), { recursive: true })
	/* a string bin, the package's own: a bin peer's that requirePeers reads, which no other peer's minds */
	writeFileSync(join(dir, "package.json"), JSON.stringify({ bin: "dist/index.js", name, version }))
	writeFileSync(join(dir, "dist", "index.js"), "")
	return join(dir, "dist", "index.js")
}

/** A locator that finds the peers in `present`, at their range's floor, and no other */
const only =
	(...present: OptionalPeer[]) =>
	(peer: OptionalPeer): string => {
		if (!present.includes(peer)) throw notFound(peer)
		return installed(peer, semver.minVersion(OPTIONAL_PEER_RANGES[peer])?.version as string)
	}

/** What `atlas version` says, as comb's tested Atlas and any build of it says it */
const says =
	(stdout: string, code = 0) =>
	async (): Promise<RunResult> => ({ code, stderr: code === 127 ? "atlas: command not found" : "", stdout })

/** The Atlas comb is tested against, on PATH */
const tested = says("atlas version v1.3.0\nhttps://github.com/ariga/atlas/releases/tag/v1.3.0\n")

/** A locator that finds each peer at 0.18.0 */
const atOld = (peer: OptionalPeer): string => installed(peer, "0.18.0")

/** A locator that fails as no missing peer does */
const denied = (): string => {
	throw new Error("EACCES")
}

describe("missingPeer", () => {
	it("names the peer, its range, why comb needs it, and an install, quoted for the shell, that lands in range", () => {
		expect(missingPeer({ peer: "postgres", why: "read the database" })).toBe(
			`comb needs postgres (>=3.4.9 <4) to read the database; install "postgres@>=3.4.9 <4"`,
		)
	})

	/* K3 of r22: comb finds a bin peer in the project and never on PATH, so the refusal sends no one there */
	it("gives a peer comb spawns the range and the install alone, as the --json refusal carries it (K3)", async () => {
		const refusal = missingPeer({ peer: "drizzle-kit", why: "export the schema" })
		expect(refusal).toBe(
			`comb needs drizzle-kit (1.0.0-rc.4 || 1.0.0-rc.5 || ^1.0.0) to export the schema; install "drizzle-kit@1.0.0-rc.4 || 1.0.0-rc.5 || ^1.0.0"`,
		)
		await expect(requirePeers("status", "d1", { atlas: tested, cwd: ROOT, locate: only() })).rejects.toThrow(
			new MissingPeerError(
				`comb needs wrangler (>=4.147.0 <5) to migrate a D1 database; install "wrangler@>=4.147.0 <5"`,
			),
		)
		expect(JSON.parse(JSON.stringify({ refused: [refusal] }))).toEqual({ refused: [refusal] })
		expect(refusal).not.toContain("PATH")
	})
})

describe("optionalPeer, on a peer that is missing", () => {
	it("refuses it, as Node and Bun word it, and keeps the resolver's error as the cause", async () => {
		const cause = notFound("postgres")
		const node = optionalPeer({ peer: "postgres", why: "read the database" }, () => Promise.reject(cause))
		await expect(node).rejects.toThrow(
			new MissingPeerError(`comb needs postgres (>=3.4.9 <4) to read the database; install "postgres@>=3.4.9 <4"`),
		)
		await expect(node).rejects.toMatchObject({ cause, name: "MissingPeerError" })
		const bun = optionalPeer({ peer: "ts-morph", why: "read" }, () =>
			Promise.reject(new Error("Cannot find module 'ts-morph' from '/p'")),
		)
		await expect(bun).rejects.toThrow(`comb needs ts-morph (>=28.0.0 <29) to read; install "ts-morph@>=28.0.0 <29"`)
	})

	/* bun 1.3 throws a failed import as a ResolveMessage that is no Error (bun 1.4's is): a consumer may run 1.3 */
	it("refuses one bun 1.3 throws as a ResolveMessage, which is no Error", async () => {
		class ResolveMessage {
			readonly code = "ERR_MODULE_NOT_FOUND"
			readonly name = "ResolveMessage"
			constructor(readonly message: string) {}
		}
		const cause = new ResolveMessage("Cannot find package 'wrangler' from '/p/src/cli/migrate-d1.ts'")
		const bun = optionalPeer({ peer: "wrangler", why: "run D1" }, () => Promise.reject(cause))
		await expect(bun).rejects.toThrow("comb needs wrangler (>=4.147.0 <5) to run D1; ")
		await expect(bun).rejects.toMatchObject({ cause, name: "MissingPeerError" })
	})

	it("refuses one a loader passes on as the cause of its own error", async () => {
		const wrapped = new Error("there was an error when mocking a module", { cause: notFound("libpg-query") })
		await expect(optionalPeer({ peer: "libpg-query", why: "parse" }, () => Promise.reject(wrapped))).rejects.toThrow(
			`comb needs libpg-query (>=17.7.4 <18) to parse; install "libpg-query@>=17.7.4 <18"`,
		)
	})

	it("passes on a failure inside the peer, another package's absence, and a throw that is no Error", async () => {
		const need = { peer: "postgres", why: "read" } as const
		const inside = new Error("boom")
		await expect(optionalPeer(need, () => Promise.reject(inside))).rejects.toBe(inside)
		const other = notFound("pg-cloudflare")
		await expect(optionalPeer(need, () => Promise.reject(other))).rejects.toBe(other)
		await expect(optionalPeer(need, () => Promise.reject("gone"))).rejects.toBe("gone")
	})
})

describe("optionalPeer, on a peer that loads", () => {
	it("is what the load loads, at a version in range, its entry a path or a file: URL", async () => {
		const entry = installed("postgres", "3.4.9")
		const need = { peer: "postgres", why: "read" } as const
		await expect(optionalPeer(need, async () => 1, { locate: () => entry })).resolves.toBe(1)
		await expect(optionalPeer(need, async () => 2, { locate: () => pathToFileURL(entry).href })).resolves.toBe(2)
		/* by default, the peer as comb resolves it: comb's own devDependency here */
		await expect(optionalPeer(need, async () => 3)).resolves.toBe(3)
	})

	/* K2 of r21: `bun add libpg-query` takes 18.x, which comb then ran */
	it("refuses a peer outside its range, naming the version found", async () => {
		const need = { peer: "libpg-query", why: "parse" } as const
		await expect(
			optionalPeer(need, async () => 1, { locate: () => installed("libpg-query", "18.2.2") }),
		).rejects.toThrow(
			new MissingPeerError(
				`comb needs libpg-query (>=17.7.4 <18, found 18.2.2) to parse; install "libpg-query@>=17.7.4 <18"`,
			),
		)
	})

	it("refuses a peer whose package names no version", async () => {
		const entry = installed("postgres", "3.4.10")
		writeFileSync(join(entry, "../../package.json"), JSON.stringify({ name: "postgres" }))
		await expect(
			optionalPeer({ peer: "postgres", why: "read" }, async () => 1, { locate: () => entry }),
		).rejects.toThrow(`comb needs postgres (>=3.4.9 <4, found no version) to read; install "postgres@>=3.4.9 <4"`)
	})
})

describe("resolvePeer", () => {
	const need = { peer: "ts-morph", why: "read" } as const

	it("is what the resolve resolves, and refuses a missing peer as optionalPeer does", () => {
		const entry = pathToFileURL(installed("ts-morph", "28.0.0")).href
		expect(resolvePeer(need, () => entry)).toBe(entry)
		expect(() =>
			resolvePeer(need, () => {
				throw notFound("ts-morph")
			}),
		).toThrow(`comb needs ts-morph (>=28.0.0 <29) to read; install "ts-morph@>=28.0.0 <29"`)
	})

	it("refuses a peer outside its range, naming the version found", () => {
		const entry = pathToFileURL(installed("ts-morph", "29.0.0")).href
		expect(() => resolvePeer(need, () => entry)).toThrow(
			`comb needs ts-morph (>=28.0.0 <29, found 29.0.0) to read; install "ts-morph@>=28.0.0 <29"`,
		)
	})
})

describe("requirePeers, on what a command needs", () => {
	it("names every peer it needs that is missing in one refusal, with one install", async () => {
		await expect(requirePeers("baseline", "postgres", { atlas: tested, cwd: ROOT, locate: only() })).rejects.toThrow(
			new MissingPeerError(
				`comb needs libpg-query (>=17.7.4 <18) to read Postgres migrations, and postgres (>=3.4.9 <4) to read what Atlas OSS leaves out of a baseline's compare; install "libpg-query@>=17.7.4 <18" "postgres@>=3.4.9 <4"`,
			),
		)
		await expect(
			requirePeers("baseline", "postgres", { atlas: tested, cwd: ROOT, locate: only("libpg-query") }),
		).rejects.toThrow(
			`comb needs postgres (>=3.4.9 <4) to read what Atlas OSS leaves out of a baseline's compare; install "postgres@>=3.4.9 <4"`,
		)
	})

	it("passes a command whose peers are all in range, and one that needs none", async () => {
		const both = only("libpg-query", "postgres")
		await expect(requirePeers("baseline", "postgres", { atlas: tested, cwd: ROOT, locate: both })).resolves.toEqual({})
		await expect(requirePeers("status", "postgres", { atlas: tested, cwd: ROOT, locate: only() })).resolves.toEqual({})
		await expect(requirePeers("check", "bun-sqlite", { atlas: tested, cwd: ROOT, locate: only() })).resolves.toEqual({})
	})

	it("leaves out a peer the command runs without: check's replay on Postgres", async () => {
		await expect(
			requirePeers("check", "postgres", { atlas: tested, cwd: ROOT, locate: only("libpg-query") }),
		).resolves.toEqual({})
		expect(PEERS.postgres.check?.some((need) => need.peer === "postgres" && need.optional === true)).toBe(true)
	})

	it("refuses a peer outside its range, and keeps a missing one's resolver error as the cause", async () => {
		await expect(requirePeers("apply", "turso", { atlas: tested, cwd: ROOT, locate: atOld })).rejects.toThrow(
			`comb needs @libsql/client (>=0.17.4 <0.18, found 0.18.0) to open a libsql or Turso database; install "@libsql/client@>=0.17.4 <0.18"`,
		)
		const missing = await (async () => {
			try {
				await requirePeers("status", "d1", { atlas: tested, cwd: ROOT, locate: only() })
			} catch (error) {
				return error
			}
		})()
		expect(missing).toMatchObject({ cause: notFound("wrangler"), name: "MissingPeerError" })
	})

	it("passes on a failure that is no missing peer", async () => {
		await expect(requirePeers("diff", "libsql", { atlas: tested, cwd: ROOT, locate: denied })).rejects.toThrow("EACCES")
	})
})

/** A package `name` at `version` in `dir`'s node_modules, its bin `bin` as its package.json gives it */
function inFolder(dir: string, { bin, name, version }: { bin: unknown; name: string; version: string }): string {
	const pkg = join(dir, ["node_", "modules"].join(""), name)
	mkdirSync(pkg, { recursive: true })
	writeFileSync(join(pkg, "package.json"), JSON.stringify({ bin, main: "index.js", name, version }))
	writeFileSync(join(pkg, "index.js"), "exports.answer = 42\n")
	return join(pkg, "package.json")
}

describe("requirePeers, finding a peer comb spawns (K1; sibling: drizzle-kit's resolution)", () => {
	/* a workspace: the root's packages, and the app's own nearer its folder */
	const root = join(ROOT, "workspace")
	const app = join(root, "app")
	const rootWrangler = inFolder(root, { bin: { wrangler: "bin/wrangler.js" }, name: "wrangler", version: "3.99.0" })
	const appWrangler = inFolder(app, {
		bin: { "cf-wrangler": "x.js", wrangler: "cli/run.js" },
		name: "wrangler",
		version: "4.150.0",
	})
	const rootKit = inFolder(root, { bin: "./bin.cjs", name: "drizzle-kit", version: "1.0.0-rc.5" })
	const src = join(app, "src")
	mkdirSync(src, { recursive: true })

	it("resolves wrangler from cwd up, the nearest package, its bin as its package.json names it, on node", async () => {
		expect(await requirePeers("status", "d1", { atlas: tested, cwd: src })).toEqual({
			wrangler: { bin: join(appWrangler, "../cli/run.js"), manifest: appWrangler, peer: "wrangler", runtime: "node" },
		})
	})

	it("refuses the wrangler cwd reaches, naming the version comb would run", async () => {
		await expect(requirePeers("check", "d1", { atlas: tested, cwd: root })).rejects.toThrow(
			`comb needs wrangler (>=4.147.0 <5, found 3.99.0) to migrate a D1 database; install "wrangler@>=4.147.0 <5"`,
		)
		expect(rootWrangler).toContain(root)
	})

	/* AD5 of the area D review: 0.20.1's `bun drizzle-kit` followed the bin's node shebang, so drizzle-kit keeps comb's own runtime */
	it("resolves drizzle-kit the same way, its bin a string, on the runtime running comb", async () => {
		expect(await requirePeers("diff", "d1", { atlas: tested, cwd: src })).toEqual({
			"drizzle-kit": {
				bin: join(rootKit, "../bin.cjs"),
				manifest: rootKit,
				peer: "drizzle-kit",
				runtime: process.execPath,
			},
		})
		await expect(requirePeers("diff", "d1", { atlas: tested, cwd: tmpdir() })).rejects.toThrow(
			`comb needs drizzle-kit (1.0.0-rc.4 || 1.0.0-rc.5 || ^1.0.0) to export the drizzle schema for comb migrate diff; install "drizzle-kit@1.0.0-rc.4 || 1.0.0-rc.5 || ^1.0.0"`,
		)
	})

	it("finds a bin peer from the entry a locator gives, and refuses a package that names no bin for it", async () => {
		const entry = join(appWrangler, "../index.js")
		expect(
			(await requirePeers("status", "d1", { atlas: tested, cwd: tmpdir(), locate: () => entry })).wrangler?.manifest,
		).toBe(appWrangler)
		const bare = inFolder(join(ROOT, "bare"), { bin: { "cf-wrangler": "x.js" }, name: "wrangler", version: "4.150.0" })
		await expect(requirePeers("status", "d1", { atlas: tested, cwd: join(bare, "../../..") })).rejects.toThrow(
			`${bare} names no wrangler bin`,
		)
	})

	it("finds a peer comb imports as comb resolves it, and gives no bin for it", async () => {
		expect(await requirePeers("check", "libsql", { atlas: tested, cwd: tmpdir() })).toEqual({})
	})
})

describe("projectBin and binOf", () => {
	it("resolves one bin peer from a folder, and refuses it missing or out of range", () => {
		const dir = join(ROOT, "one")
		const manifest = inFolder(dir, { bin: { wrangler: "w.js" }, name: "wrangler", version: "4.150.0" })
		expect(projectBin(WRANGLER, dir)).toEqual({
			bin: join(manifest, "../w.js"),
			manifest,
			peer: "wrangler",
			runtime: "node",
		})
		expect(() => projectBin(WRANGLER, tmpdir())).toThrow(`comb needs wrangler (>=4.147.0 <5) to migrate a D1 database`)
		inFolder(join(ROOT, "old"), { bin: { wrangler: "w.js" }, name: "wrangler", version: "3.0.0" })
		expect(() => projectBin(WRANGLER, join(ROOT, "old"))).toThrow("found 3.0.0")
	})

	it("is the bin requirePeers resolved, and an error for one it did not", () => {
		const bin = { bin: "/w.js", manifest: "/package.json", peer: "wrangler", runtime: "node" } as const
		expect(binOf({ wrangler: bin }, "wrangler")).toBe(bin)
		expect(() => binOf({}, "drizzle-kit")).toThrow("comb resolved no drizzle-kit for this command")
	})

	it("imports the package a bin peer resolved to, by its entry", async () => {
		const manifest = inFolder(join(ROOT, "imports"), {
			bin: { wrangler: "w.js" },
			name: "wrangler",
			version: "4.150.0",
		})
		const bin = { bin: join(manifest, "../w.js"), manifest, peer: "wrangler", runtime: "node" } as const
		await expect(importBin<{ answer: number }>(bin)).resolves.toMatchObject({ answer: 42 })
		const broken = inFolder(join(ROOT, "broken"), { bin: { wrangler: "w.js" }, name: "wrangler", version: "4.150.0" })
		writeFileSync(join(broken, "../index.js"), "throw new Error('boom')\n")
		await expect(importBin({ ...bin, manifest: broken })).rejects.toThrow("boom")
	})

	/* D4-5 of the area D round-four review: wrangler's module cannot be loaded from the project inside a compiled executable */
	it("refuses to import a peer from a Bun single-file executable, before any import, saying why", async () => {
		const bin = { bin: "/nowhere/w.js", manifest: "/nowhere/package.json", peer: "wrangler", runtime: "node" } as const
		await expect(importBin(bin, "file:///$bunfs/root/app-exe")).rejects.toThrow(
			new Error(
				"comb loads wrangler from the project, which a Bun single-file executable cannot do: run it with bun or node, not from a compiled executable",
			),
		)
	})
})

/* KC3, PA5, KC6 and PA22 of r22: Atlas and a declared FTS's ts-morph are rows of the one table, each named in the refusal */
describe("Atlas is a row of the peer table (PA5, KC6 + PA22; sibling: K3's PATH-free refusal)", () => {
	const ATLAS = `atlas (${ATLAS_RANGE}) to hash, diff and apply migrations`
	const INSTALL = "atlas from https://atlasgo.io/getting-started"

	it("refuses an Atlas outside its range by the version it says, with the install page, official or community", async () => {
		const old = says("atlas community version v0.32.0\nhttps://github.com/ariga/atlas/releases/tag/v0.32.0\n")
		await expect(requirePeers("status", "postgres", { atlas: old, cwd: ROOT, locate: only() })).rejects.toThrow(
			new MissingPeerError(
				`comb needs atlas (${ATLAS_RANGE}, found 0.32.0) to hash, diff and apply migrations; install ${INSTALL}`,
			),
		)
		const next = says("atlas version v2.0.0\n")
		await expect(
			requirePeers("apply", "libsql", { atlas: next, cwd: ROOT, locate: only("@libsql/client") }),
		).rejects.toThrow(`found 2.0.0`)
		const community = says("atlas community version v1.3.0\n")
		const found = requirePeers("check", "bun-sqlite", { atlas: community, cwd: ROOT, locate: only() })
		await expect(found).resolves.toEqual({})
	})

	it("refuses a missing Atlas, and one that says no version, on every command that runs it, Postgres status included", async () => {
		const missing = says("", 127)
		for (const command of ["apply", "baseline", "check", "diff", "status"] as const)
			await expect(
				requirePeers(command, "postgres", {
					atlas: missing,
					cwd: ROOT,
					locate: only("libpg-query", "postgres", "drizzle-kit"),
				}),
			).rejects.toThrow(`comb needs ${ATLAS}; install ${INSTALL}`)
		await expect(
			requirePeers("diff", "d1", { atlas: says("", 1), cwd: ROOT, locate: only("drizzle-kit") }),
		).rejects.toThrow(`atlas (${ATLAS_RANGE}, found no version, as atlas version exited 1)`)
		/* D4-1 of the area D round-four review: one that exits 0 and prints no version */
		await expect(
			requirePeers("diff", "d1", { atlas: says("atlas: unknown\n"), cwd: ROOT, locate: only("drizzle-kit") }),
		).rejects.toThrow(`atlas (${ATLAS_RANGE}, found no version)`)
	})

	it("names Atlas with the npm peers in one refusal, the installs together", async () => {
		await expect(
			requirePeers("baseline", "postgres", { atlas: says("", 127), cwd: ROOT, locate: only() }),
		).rejects.toThrow(
			`comb needs libpg-query (>=17.7.4 <18) to read Postgres migrations, and postgres (>=3.4.9 <4) to read what Atlas OSS leaves out of a baseline's compare, and ${ATLAS}; install "libpg-query@>=17.7.4 <18" "postgres@>=3.4.9 <4", and ${INSTALL}`,
		)
	})

	it("reads Atlas's version once, only where the command runs Atlas", async () => {
		let reads = 0
		const counted = async () => {
			reads++
			return tested()
		}
		await requirePeers("check", "libsql", { atlas: counted, cwd: ROOT, locate: only("@libsql/client") })
		expect(reads).toBe(1)
		await requirePeers("status", "libsql", { atlas: counted, cwd: ROOT, locate: only("@libsql/client") })
		await requirePeers("status", "turso", { atlas: counted, cwd: ROOT, locate: only("@libsql/client") })
		expect(reads).toBe(1)
	})
})

/* AD11 of the area D review: a version manager's shim with no version set exits 1, and says why on stderr */
const shim = async (): Promise<RunResult> => ({
	code: 1,
	stderr: "\nmise ERROR No version is set for shim: atlas\nSet a global default version\n",
	stdout: "",
})

describe("an Atlas that exits otherwise than found or missing (AD11)", () => {
	it("keeps the first line it says on stderr, as the reason it found no version", async () => {
		await expect(
			requirePeers("check", "postgres", { atlas: shim, cwd: ROOT, locate: only("libpg-query") }),
		).rejects.toThrow(
			new MissingPeerError(
				`comb needs atlas (${ATLAS_RANGE}, found no version, as atlas version exited 1: mise ERROR No version is set for shim: atlas) to hash, diff and apply migrations; install atlas from https://atlasgo.io/getting-started`,
			),
		)
	})
})

/* KC3 of r22: the FTS part of a SQLite diff loads the tables file, through ts-morph */
describe("a SQLite diff whose comb.config.ts declares FTS needs ts-morph (KC3; sibling: drizzle-kit's row)", () => {
	it("adds ts-morph to a SQLite-family diff whose comb.config.ts declares FTS, named with drizzle-kit in one refusal", async () => {
		const KIT = `drizzle-kit (${OPTIONAL_PEER_RANGES["drizzle-kit"]}) to export the drizzle schema for comb migrate diff`
		const MORPH = `ts-morph (>=28.0.0 <29) to read the tables file whose FTS comb.config.ts declares`
		const install = `install "drizzle-kit@${OPTIONAL_PEER_RANGES["drizzle-kit"]}" "ts-morph@>=28.0.0 <29"`
		for (const provider of ["bun-sqlite", "d1", "libsql", "turso"] as const)
			await expect(
				requirePeers("diff", provider, { atlas: tested, cwd: ROOT, fts: true, locate: only() }),
			).rejects.toThrow(`comb needs ${KIT}, and ${MORPH}; ${install}`)
		await expect(
			requirePeers("diff", "libsql", { atlas: tested, cwd: ROOT, fts: false, locate: only() }),
		).rejects.toThrow(`comb needs ${KIT}; install "drizzle-kit@`)
		await expect(
			requirePeers("diff", "d1", { atlas: tested, cwd: ROOT, fts: true, locate: only("drizzle-kit", "ts-morph") }),
		).resolves.toEqual({
			"drizzle-kit": expect.objectContaining({ peer: "drizzle-kit", runtime: process.execPath }),
		})
		/* Postgres has no FTS of comb's: its diff never loads the tables file */
		await expect(
			requirePeers("diff", "postgres", {
				atlas: tested,
				cwd: ROOT,
				fts: true,
				locate: only("drizzle-kit", "libpg-query"),
			}),
		).resolves.toEqual({
			"drizzle-kit": expect.objectContaining({ peer: "drizzle-kit", runtime: process.execPath }),
		})
	})
})
