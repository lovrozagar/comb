/**
 * S6 of the 0.15.0 review: a Turso apply that comb refused had created the Turso database first,
 * since the provider's connect POSTs /databases on a 404 before any check runs. A Turso run now
 * checks on a read-only connection, a missing database read as an empty one, and creates the
 * database and mints a full-access token only when there is something to apply. The Turso API is
 * faked through fetch; the libsql client is routed to a local file.
 */
import fs from "node:fs"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { type MigrateProject, migrateCli, migrateProject, sqliteRows } from "../support/migrate-project.ts"

const routed = vi.hoisted(() => ({ url: "" }))
vi.mock("@libsql/client", async (load) => {
	const real = await load<typeof import("@libsql/client")>()
	return {
		...real,
		createClient: (config: { url: string }) =>
			real.createClient({ url: config.url.startsWith("libsql://") ? routed.url : config.url }),
	}
})

/** The Turso API for org acme, holding `core` once it `exists`; each call kept as `METHOD path` */
function fakeTurso(exists: boolean) {
	const state = { calls: [] as string[], exists }
	vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
		const url = String(input).replace("https://api.turso.tech/v1/organizations/acme", "")
		state.calls.push(`${init?.method ?? "GET"} ${url}`)
		if (init?.method === "POST" && url === "/databases") {
			state.exists = true
			return Response.json({ database: { Name: "core" } })
		}
		if (url.includes("/auth/tokens")) return Response.json({ jwt: "jwt" })
		if (!state.exists) return Response.json({ error: "not found" }, { status: 404 })
		return Response.json({ database: { Hostname: "core-acme.turso.io" } })
	})
	return state
}

const projects: MigrateProject[] = []
afterEach(() => {
	vi.unstubAllGlobals()
	for (const project of projects.splice(0)) project.dispose()
})

/** A project whose local environment is the Turso database `core`, which the libsql client reaches as `local.db` */
function tursoProject(migrations: Record<string, string>): MigrateProject {
	const project = migrateProject(migrations)
	projects.push(project)
	routed.url = project.url
	fs.writeFileSync(
		path.join(project.dir, "comb.migrate.config.ts"),
		`export default { databases: { core: { migrationsDir: "./m", environments: {
	local: { name: "core", provider: { type: "turso", org: "acme", apiToken: "fake" } },
} } } }\n`,
	)
	return project
}

const INIT = { "1_init.sql": "CREATE TABLE post (id INTEGER PRIMARY KEY);" }
const FULL = "POST /databases/core/auth/tokens?expiration=1h&authorization=full-access"

describe("migrate apply on a Turso database that does not exist", () => {
	beforeEach(() => {
		routed.url = ""
	})

	it("creates no database, and mints no full-access token, when atlas.sum refuses the run", async () => {
		const { dir, migrationsDir } = tursoProject(INIT)
		fs.appendFileSync(path.join(migrationsDir, "1_init.sql"), "\n-- edited")
		const turso = fakeTurso(false)
		const run = await migrateCli(dir, ["migrate", "apply", "core", "--yes"])
		expect(run.code).toBe(1)
		expect(run.errors.join("\n")).toContain("atlas.sum does not match its migrations")
		expect(turso.exists).toBe(false)
		expect(turso.calls).not.toContain(FULL)
	})

	it("creates it to apply the pending files, checked as an empty database", async () => {
		const { dir, url } = tursoProject(INIT)
		const turso = fakeTurso(false)
		const run = await migrateCli(dir, ["migrate", "apply", "core"])
		expect(run.code, run.errors.join("\n")).toBe(0)
		expect(turso.calls).toContain("POST /databases")
		expect(turso.calls).toContain(FULL)
		expect(await sqliteRows(url, "SELECT name FROM __drizzle_migrations")).toEqual([["1_init.sql"]])
	})
})

describe("migrate apply on a Turso database with nothing pending", () => {
	it("reads it with a read-only token and writes nothing", async () => {
		const { dir } = tursoProject(INIT)
		fakeTurso(true)
		expect((await migrateCli(dir, ["migrate", "apply", "core"])).code).toBe(0)
		const turso = fakeTurso(true)
		const run = await migrateCli(dir, ["migrate", "apply", "core"])
		expect(run.code, run.errors.join("\n")).toBe(0)
		expect(turso.calls).not.toContain(FULL)
	})
})
