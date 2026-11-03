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
	PEERS,
	requirePeers,
	resolvePeer,
} from "./optional-peer.ts"

/** The error Node's resolver gives for a package the project lacks */
const notFound = (name: string): Error =>
	Object.assign(new Error(`Cannot find package '${name}' imported from /p/x.js`), { code: "ERR_MODULE_NOT_FOUND" })

const ROOT = mkdtempSync(join(tmpdir(), "comb-optional-peer-"))
afterAll(() => rmSync(ROOT, { force: true, recursive: true }))

/** The entry of a package `name` at `version`, laid out as an install lays it, under a folder of its own */
function installed(name: string, version: string): string {
	const dir = join(ROOT, `${name.replace(/\W/g, "-")}-${version}`, "node_modules", name)
	mkdirSync(join(dir, "dist"), { recursive: true })
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version }))
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

	it("tells a global comb where a peer it runs as a command is found", () => {
		expect(missingPeer({ peer: "drizzle-kit", why: "export the schema" })).toBe(
			`comb needs drizzle-kit (1.0.0-rc.4 || 1.0.0-rc.5 || ^1.0.0) to export the schema; run comb through a package script, so node_modules/.bin is on PATH, or install "drizzle-kit@1.0.0-rc.4 || 1.0.0-rc.5 || ^1.0.0"`,
		)
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
		await expect(
			optionalPeer(
				need,
				async () => 1,
				() => entry,
			),
		).resolves.toBe(1)
		await expect(
			optionalPeer(
				need,
				async () => 2,
				() => pathToFileURL(entry).href,
			),
		).resolves.toBe(2)
		/* by default, the peer as comb resolves it: comb's own devDependency here */
		await expect(optionalPeer(need, async () => 3)).resolves.toBe(3)
	})

	/* K2 of r21: `bun add libpg-query` takes 18.x, which comb then ran */
	it("refuses a peer outside its range, naming the version found", async () => {
		const need = { peer: "libpg-query", why: "parse" } as const
		await expect(
			optionalPeer(
				need,
				async () => 1,
				() => installed("libpg-query", "18.2.2"),
			),
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
			optionalPeer(
				{ peer: "postgres", why: "read" },
				async () => 1,
				() => entry,
			),
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
	it("names every peer it needs that is missing in one refusal, with one install", () => {
		expect(() => requirePeers("baseline", "postgres", { cwd: ROOT, locate: only() })).toThrow(
			new MissingPeerError(
				`comb needs libpg-query (>=17.7.4 <18) to read Postgres migrations, and postgres (>=3.4.9 <4) to read what Atlas OSS leaves out of a baseline's compare; install "libpg-query@>=17.7.4 <18" "postgres@>=3.4.9 <4"`,
			),
		)
		expect(() => requirePeers("baseline", "postgres", { cwd: ROOT, locate: only("libpg-query") })).toThrow(
			`comb needs postgres (>=3.4.9 <4) to read what Atlas OSS leaves out of a baseline's compare; install "postgres@>=3.4.9 <4"`,
		)
	})

	it("passes a command whose peers are all in range, and one that needs none", () => {
		const both = only("libpg-query", "postgres")
		expect(() => requirePeers("baseline", "postgres", { cwd: ROOT, locate: both })).not.toThrow()
		expect(() => requirePeers("status", "postgres", { cwd: ROOT, locate: only() })).not.toThrow()
		expect(() => requirePeers("check", "bun-sqlite", { cwd: ROOT, locate: only() })).not.toThrow()
	})

	it("leaves out a peer the command runs without: check's replay on Postgres", () => {
		expect(() => requirePeers("check", "postgres", { cwd: ROOT, locate: only("libpg-query") })).not.toThrow()
		expect(PEERS.postgres.check?.some((need) => need.peer === "postgres" && need.optional === true)).toBe(true)
	})

	it("refuses a peer outside its range, and keeps a missing one's resolver error as the cause", () => {
		expect(() => requirePeers("apply", "turso", { cwd: ROOT, locate: atOld })).toThrow(
			`comb needs @libsql/client (>=0.17.4 <0.18, found 0.18.0) to open a libsql or Turso database; install "@libsql/client@>=0.17.4 <0.18"`,
		)
		const missing = (() => {
			try {
				requirePeers("status", "d1", { cwd: ROOT, locate: only() })
			} catch (error) {
				return error
			}
		})()
		expect(missing).toMatchObject({ cause: notFound("wrangler"), name: "MissingPeerError" })
	})

	it("passes on a failure that is no missing peer", () => {
		expect(() => requirePeers("diff", "libsql", { cwd: ROOT, locate: denied })).toThrow("EACCES")
	})
})

describe("requirePeers, finding a peer", () => {
	it("finds drizzle-kit as `bun drizzle-kit` runs it: in the project, from its folder up", () => {
		const entry = installed("drizzle-kit", "1.0.0-rc.4")
		const project = join(entry, "../../../..", "app", "src")
		mkdirSync(project, { recursive: true })
		expect(() => requirePeers("diff", "d1", { cwd: project })).not.toThrow()
		expect(() => requirePeers("diff", "d1", { cwd: tmpdir() })).toThrow(
			"comb needs drizzle-kit (1.0.0-rc.4 || 1.0.0-rc.5 || ^1.0.0) to export the drizzle schema for comb migrate diff; run comb through a package script",
		)
	})

	it("finds a peer comb imports as comb resolves it", () => {
		expect(() => requirePeers("check", "libsql", { cwd: tmpdir() })).not.toThrow()
	})
})
