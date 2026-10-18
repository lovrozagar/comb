/**
 * The README's path on D1, end to end: codegen and `migrate diff`, then `migrate apply --local`
 * through the real wrangler onto its local D1, with no comb.migrate.config.ts: the database is
 * the wrangler binding's.
 */
import { beforeAll, describe, expect, it } from "vitest"
import { app, BLOG, ok, type App } from "./support/project.ts"

const WRANGLER_TOML = `name = "e2e"
compatibility_date = "2026-10-01"

[[d1_databases]]
binding = "CORE"
database_name = "core"
database_id = "00000000-0000-0000-0000-000000000000"
`

let worker: App

beforeAll(() => {
	worker = app({ ...BLOG, "wrangler.toml": WRANGLER_TOML })
	ok(worker.comb("codegen", "core"), "codegen")
	ok(worker.comb("migrate", "init"), "migrate init")
	ok(worker.comb("migrate", "diff", "core", "init"), "migrate diff")
}, 180_000)

describe("comb on D1 --local, from tables to a migrated database", () => {
	it("applies the diffed migration through wrangler, records it, and skips it the next time", () => {
		expect(ok(worker.comb("migrate", "apply", "core", "--local"), "apply").stdout).toContain("1 applied")
		expect(ok(worker.comb("migrate", "apply", "core", "--local"), "apply again").stdout).toContain(
			"Skip (already applied)",
		)
		const tables = ok(
			worker.wrangler(
				"d1",
				"execute",
				"core",
				"--local",
				"--json",
				"--command=SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
			),
			"wrangler d1 execute",
		)
		expect(tables.stdout).toContain('"post"')
		expect(tables.stdout).toContain('"__drizzle_migrations"')
	}, 180_000)

	it("lets the migrated table enforce its unique index on D1", () => {
		const insert = (id: string) =>
			worker.wrangler(
				"d1",
				"execute",
				"core",
				"--local",
				`--command=INSERT INTO post (id, title) VALUES ('${id}', 'Same')`,
			)
		ok(insert("pst_1"), "first insert")
		const second = insert("pst_2")
		expect(second.status).not.toBe(0)
		expect(`${second.stdout}${second.stderr}`).toContain("UNIQUE constraint failed: post.title")
	}, 120_000)
})
