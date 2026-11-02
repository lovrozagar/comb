import { describe, expect, it } from "vitest"
import { MissingPeerError, missingPeer, optionalPeer, resolvePeer } from "./optional-peer.ts"

/** The error Node's resolver gives for a package the project lacks */
const notFound = (name: string): Error =>
	Object.assign(new Error(`Cannot find package '${name}' imported from /p/x.js`), { code: "ERR_MODULE_NOT_FOUND" })

describe("missingPeer", () => {
	it("names the peer, its range, why comb needs it, and the install", () => {
		expect(missingPeer("postgres", "read the database")).toBe(
			"comb needs postgres (>=3.4.9 <4) to read the database; install postgres",
		)
	})

	it("tells a global comb where a peer it runs as a command is found", () => {
		expect(missingPeer("drizzle-kit", "export the schema")).toBe(
			"comb needs drizzle-kit (1.0.0-rc.4 || 1.0.0-rc.5 || ^1.0.0) to export the schema; run comb through a package script, so node_modules/.bin is on PATH, or install drizzle-kit",
		)
	})
})

describe("optionalPeer", () => {
	it("is what the load loads", async () => {
		await expect(optionalPeer("postgres", "read", async () => 1)).resolves.toBe(1)
	})

	it("refuses a missing peer, as Node and Bun word it, and keeps the resolver's error as the cause", async () => {
		const cause = notFound("postgres")
		const node = optionalPeer("postgres", "read the database", () => Promise.reject(cause))
		await expect(node).rejects.toThrow(
			new MissingPeerError("comb needs postgres (>=3.4.9 <4) to read the database; install postgres"),
		)
		await expect(node).rejects.toMatchObject({ cause, name: "MissingPeerError" })
		const bun = optionalPeer("ts-morph", "read", () =>
			Promise.reject(new Error("Cannot find module 'ts-morph' from '/p'")),
		)
		await expect(bun).rejects.toThrow("comb needs ts-morph (>=28.0.0 <29) to read; install ts-morph")
	})

	/* bun 1.3 throws a failed import as a ResolveMessage that is no Error (bun 1.4's is): CI's consumers, on 1.3.11 */
	it("refuses a missing peer bun 1.3 throws as a ResolveMessage, which is no Error", async () => {
		class ResolveMessage {
			readonly code = "ERR_MODULE_NOT_FOUND"
			readonly name = "ResolveMessage"
			constructor(readonly message: string) {}
		}
		const cause = new ResolveMessage("Cannot find package 'wrangler' from '/p/src/cli/migrate-d1.ts'")
		const bun = optionalPeer("wrangler", "run D1", () => Promise.reject(cause))
		await expect(bun).rejects.toThrow("comb needs wrangler (>=4.147.0 <5) to run D1; ")
		await expect(bun).rejects.toMatchObject({ cause, name: "MissingPeerError" })
	})

	it("refuses a missing peer a loader passes on as the cause of its own error", async () => {
		const wrapped = new Error("there was an error when mocking a module", { cause: notFound("libpg-query") })
		await expect(optionalPeer("libpg-query", "parse", () => Promise.reject(wrapped))).rejects.toThrow(
			"comb needs libpg-query (>=17.7.4 <18) to parse; install libpg-query",
		)
	})

	it("passes on a failure inside the peer, another package's absence, and a throw that is no Error", async () => {
		const inside = new Error("boom")
		await expect(optionalPeer("postgres", "read", () => Promise.reject(inside))).rejects.toBe(inside)
		const other = notFound("pg-cloudflare")
		await expect(optionalPeer("postgres", "read", () => Promise.reject(other))).rejects.toBe(other)
		await expect(optionalPeer("postgres", "read", () => Promise.reject("gone"))).rejects.toBe("gone")
	})
})

describe("resolvePeer", () => {
	it("is what the resolve resolves, and refuses a missing peer as optionalPeer does", () => {
		expect(resolvePeer("ts-morph", "read", () => "file:///p/ts-morph/index.js")).toBe("file:///p/ts-morph/index.js")
		expect(() =>
			resolvePeer("ts-morph", "read", () => {
				throw notFound("ts-morph")
			}),
		).toThrow("comb needs ts-morph (>=28.0.0 <29) to read; install ts-morph")
	})
})
