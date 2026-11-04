/**
 * The integration suites on the shared Postgres test server run in vitest.config.ts's Postgres
 * projects, whose global setup holds the run's lock on the server (tests/integration/support/
 * pg-run-lock.ts), so two runs of them on one server serialize: every such suite, found by its own
 * text (tests/support/pg-suites.ts), and no other, so a run of codegen or SQLite alone never waits on
 * a Postgres run. Each suite runs once in each zone it runs in.
 */
import { globSync, readdirSync, readFileSync } from "node:fs"
import { join, matchesGlob } from "node:path"
import { describe, expect, it } from "vitest"
import config from "../../vitest.config.ts"
import { DATE_KEYS } from "../support/off-utc.ts"
import { PG_INTEGRATION, PG_REACH } from "../support/pg-suites.ts"

const CORE = join(import.meta.dirname, "../..")
const LOCK = "tests/integration/support/pg-run-lock.ts"

type Project = { env?: { TZ?: string }; exclude?: string[]; globalSetup?: string[]; include?: string[]; name?: string }
const projects = (config.test?.projects ?? []).map((project) => (project as { test: Project }).test)

/** Every integration suite, relative to packages/core */
const suites = (readdirSync(join(CORE, "tests/integration"), { recursive: true }) as string[])
	.filter((name) => name.endsWith(".test.ts"))
	.map((name) => `tests/integration/${name}`)
	.toSorted()

/** The projects that run `file`, by name */
const runners = (file: string): Project[] =>
	projects.filter(
		(project) =>
			(project.include ?? []).some((glob) => matchesGlob(file, glob)) &&
			!(project.exclude ?? []).some((glob) => matchesGlob(file, glob)),
	)

/** Whether `file` reaches the Postgres test server, by its directory or its text */
const reaches = (file: string): boolean =>
	file.startsWith("tests/integration/postgres/") || PG_REACH.test(readFileSync(join(CORE, file), "utf8"))

describe("the Postgres projects", () => {
	it("list every integration suite that reaches the Postgres test server, and no other", () => {
		expect(suites.filter((file) => PG_INTEGRATION.some((glob) => matchesGlob(file, glob)))).toEqual(
			suites.filter(reaches),
		)
		for (const glob of PG_INTEGRATION) expect(globSync(glob, { cwd: CORE }).length, glob).toBeGreaterThan(0)
	})

	it("run each such suite under the run's lock, and each other suite outside it, once in UTC", () => {
		const wrong = suites.flatMap((file) => {
			const utc = runners(file).filter((project) => project.env === undefined)
			const locked = utc.length === 1 && (utc[0]?.globalSetup ?? []).includes(LOCK)
			return utc.length === 1 && locked === reaches(file) ? [] : [`${file}: ${utc.map((p) => p.name).join(", ")}`]
		})
		expect(wrong).toEqual([])
	})

	it("run each Date-key suite once more off UTC, under the lock where it reaches the server", () => {
		const wrong = suites
			.filter((file) => DATE_KEYS.test(readFileSync(join(CORE, file), "utf8")))
			.flatMap((file) => {
				const off = runners(file).filter((project) => project.env !== undefined)
				const locked = off.length === 1 && (off[0]?.globalSetup ?? []).includes(LOCK)
				return off.length === 1 && locked === reaches(file) ? [] : [`${file}: ${off.map((p) => p.name).join(", ")}`]
			})
		expect(wrong).toEqual([])
	})

	it("reads a suite as reaching the server by a Postgres helper's import or the server's variable, and not by a name that only resembles one", () => {
		expect(PG_REACH.test('import { pgUrl } from "../support/pg.ts"')).toBe(true)
		expect(PG_REACH.test('import { query } from "../support/pg-roles.ts"')).toBe(true)
		expect(PG_REACH.test("env: { COMB_TEST_PG_URL: url }")).toBe(true)
		expect(PG_REACH.test('import { parse } from "../support/pg-parser.ts"')).toBe(false)
		expect(PG_REACH.test('import { libsql } from "../support/libsql.ts"')).toBe(false)
	})
})
