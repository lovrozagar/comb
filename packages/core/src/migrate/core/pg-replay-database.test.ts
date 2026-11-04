import { describe, expect, it } from "vitest"
import { coded, fake } from "../__fixtures__/pg-admin.ts"
import { claim, copyExtensions, makeDatabase } from "./pg-replay-database.ts"

describe("claim", () => {
	it.each([
		[130000, { application_name: "comb_replay 41_1793680844883080" }],
		[140000, { application_name: "comb_replay 41_1793680844883080", client_connection_check_interval: "1s" }],
		[170000, { application_name: "comb_replay 41_1793680844883080", client_connection_check_interval: "1s" }],
	])(
		"names the backend by its pid and its start, and on server_version_num %i tags it with %j",
		async (version, settings) => {
			const admin = fake((query) =>
				query.startsWith("SELECT pid") ? [{ pid: 41, start: "1793680844883080", version }] : [],
			)
			expect(await claim(admin.sql)).toEqual({ owner: "41_1793680844883080", settings })
			expect(admin.sent[0]).toMatch(
				/current_setting\('server_version_num'\)::int AS version FROM pg_stat_activity WHERE pid = pg_backend_pid\(\)$/,
			)
			expect(admin.sent[1]).toBe(
				`SELECT ${Object.keys(settings)
					.map((_, i) => `set_config($${2 * i + 1}, $${2 * i + 2}, false)`)
					.join(", ")}`,
			)
		},
	)
})

describe("makeDatabase", () => {
	it("makes a database named for the backend that owns it, from template0", async () => {
		const admin = fake()
		const name = await makeDatabase(admin.sql, "41_1234", () => new Error("refused"))
		expect(name).toMatch(/^comb_replay_41_1234_[0-9a-f]{8}$/)
		expect(admin.sent).toEqual([`CREATE DATABASE ${name} TEMPLATE template0`])
	})

	it("refuses a role without CREATEDB, and throws any other failure", async () => {
		const denied = fake(() => coded("42501"))
		await expect(makeDatabase(denied.sql, "1_1", () => new Error("no CREATEDB"))).rejects.toThrow("no CREATEDB")
		const full = fake(() => coded("53100", "disk full"))
		await expect(makeDatabase(full.sql, "1_1", () => new Error("no CREATEDB"))).rejects.toThrow("disk full")
	})
})

describe("copyExtensions", () => {
	const held = [
		{ name: "plpgsql", schema: "pg_catalog", version: "1.0" },
		{ name: "citext", schema: "public", version: "1.6" },
		{ name: "pg_trgm", schema: "ext", version: "1'5" },
	]

	it("makes each extension in its schema at its version, making a schema of its own first", async () => {
		const to = fake()
		await copyExtensions(fake(() => held).sql, to.sql, { makes: new Set(), refused: () => new Error("refused") })
		expect(to.sent).toEqual([
			`CREATE EXTENSION IF NOT EXISTS "plpgsql" WITH SCHEMA "pg_catalog" VERSION '1.0'`,
			`CREATE EXTENSION IF NOT EXISTS "citext" WITH SCHEMA "public" VERSION '1.6'`,
			'CREATE SCHEMA IF NOT EXISTS "ext"',
			`CREATE EXTENSION IF NOT EXISTS "pg_trgm" WITH SCHEMA "ext" VERSION '1''5'`,
		])
	})

	it("refuses an extension it cannot make, naming it", async () => {
		const to = fake((query) => (query.includes("citext") ? coded("42501") : []))
		await expect(
			copyExtensions(fake(() => held).sql, to.sql, {
				makes: new Set(),
				refused: (name) => new Error(`cannot make ${name}`),
			}),
		).rejects.toThrow("cannot make citext")
	})

	/* P5 of r21 */
	it("leaves an extension the history makes to the history", async () => {
		const to = fake()
		await copyExtensions(fake(() => held).sql, to.sql, { makes: new Set(["citext"]), refused: () => new Error("x") })
		expect(to.sent.some((sent) => sent.includes("citext"))).toBe(false)
		expect(to.sent).toHaveLength(3)
	})
})

/** A role's row as createRole reads it, with its comment */
