/**
 * The integration suites on the shared Postgres test server run in vitest.config.ts's Postgres
 * projects, whose global setup holds the run's lock on the server (tests/integration/support/
 * pg-run-lock.ts), so two runs of them on one server serialize: every such suite, found by its own
 * text (tests/support/pg-suites.ts), and no other, so a run of codegen or SQLite alone never waits on
 * a Postgres run. Each suite runs once in each zone it runs in. Past the integration suites, no test
 * file anywhere in the package reaches the server outside the lock, however it is run: one that does,
 * read from its code (support/pg-reach.ts), runs only in the locked projects or takes the lock itself
 * through tests/support/pg-lock.ts, as the bun:test, consumer and e2e suites run apart from vitest's.
 * macOS's runners have no Postgres, so no file vitest.posix.config.ts runs reaches the server.
 */
import { globSync, readdirSync, readFileSync } from "node:fs"
import { join, matchesGlob } from "node:path"
import { describe, expect, it } from "vitest"
import config from "../../vitest.config.ts"
import posixConfig from "../../vitest.posix.config.ts"
import { DATE_KEYS } from "../support/off-utc.ts"
import { PG_INTEGRATION, PG_REACH } from "../support/pg-suites.ts"
import { reachesPg, readsPgVar, takesPgLock } from "./support/pg-reach.ts"

const CORE = join(import.meta.dirname, "../..")
const LOCK = "tests/integration/support/pg-run-lock.ts"

type Project = { env?: { TZ?: string }; exclude?: string[]; globalSetup?: string[]; include?: string[]; name?: string }
const projects = (config.test?.projects ?? []).map((project) => (project as { test: Project }).test)

/** Every integration suite, relative to packages/core */
const suites = (readdirSync(join(CORE, "tests/integration"), { recursive: true }) as string[])
	.filter((name) => name.endsWith(".test.ts"))
	.map((name) => `tests/integration/${name}`)
	.toSorted()

/** Every test file in the package, whichever runner runs it, relative to packages/core */
const testFiles = ["src", "lint", "tests"]
	.flatMap((dir) => (readdirSync(join(CORE, dir), { recursive: true }) as string[]).map((name) => `${dir}/${name}`))
	.filter((name) => name.endsWith(".test.ts"))
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

describe("every test file that reaches the Postgres test server", () => {
	it("let no test file reach the server outside the run's lock, however it is run, naming each that does", () => {
		const unlocked = testFiles.filter((file) => {
			const text = readFileSync(join(CORE, file), "utf8")
			if (!reachesPg(text) || takesPgLock(text)) return false
			const run = runners(file)
			return run.length === 0 || !run.every((project) => (project.globalSetup ?? []).includes(LOCK))
		})
		expect(unlocked).toEqual([])
	})

	it("take the server's URL through pgUrl, which refuses it unset or empty, never by reading the variable", () => {
		expect(testFiles.filter((file) => readsPgVar(readFileSync(join(CORE, file), "utf8")))).toEqual([])
		expect(readsPgVar('const url = process.env["COMB_TEST_PG_URL"] ?? ""')).toBe(true)
		expect(readsPgVar("JSON.stringify(process.env.COMB_TEST_PG_URL)")).toBe(true)
		expect(readsPgVar("spawn(cmd, { env: { COMB_TEST_PG_URL: pgUrl() } })")).toBe(false)
		expect(readsPgVar("const url = env[PG_URL_VAR]")).toBe(false)
	})

	it("reads a file as reaching the server by what its code does, and as taking the lock by the helper's call", () => {
		for (const code of [
			'import pg from "pg"',
			'import postgres, { type Sql } from "postgres"',
			'import { pgUrl } from "../integration/support/pg.ts"',
			'import { pgUrl } from "../support/pg-url.ts"',
			'const pg = await import("pg")',
			"const url = process.env.COMB_TEST_PG_URL",
			'const url = process.env["COMB_TEST_PG_URL"]',
			"spawn(cmd, { env: { COMB_TEST_PG_URL: url } })",
		])
			expect(reachesPg(code), code).toBe(true)
		for (const code of [
			'import type pg from "pg"',
			'import { type Sql } from "postgres"',
			`const fixture = 'import pg from "pg"'`,
			'expect(text).toContain("COMB_TEST_PG_URL: postgres://comb@localhost/comb")',
			"// reads COMB_TEST_PG_URL",
			'import { parse } from "../support/pg-parser.ts"',
		])
			expect(reachesPg(code), code).toBe(false)
		const helper = 'import { acquirePgRunLock } from "../support/pg-lock.ts"'
		expect(takesPgLock(`${helper}\nbeforeAll(async () => { release = await acquirePgRunLock(url) })`)).toBe(true)
		expect(takesPgLock(helper)).toBe(false)
		expect(takesPgLock("const acquirePgRunLock = () => 0; acquirePgRunLock()")).toBe(false)
	})
})

/* CI on 9857b8e0: the macOS integration job ran json-stored-document, whose Postgres half needs a server macOS has not */
describe("the macOS suites (vitest.posix.config.ts)", () => {
	const posix = (posixConfig.test?.projects ?? []).map((project) => (project as { test: Project }).test)
	const runsOnMac = (file: string): boolean =>
		posix.some(
			(project) =>
				(project.include ?? []).some((glob) => matchesGlob(file, glob)) &&
				!(project.exclude ?? []).some((glob) => matchesGlob(file, glob)),
		)

	it("run no test file that reaches the Postgres test server, naming each that does", () => {
		const onMac = testFiles.filter(runsOnMac)
		expect(onMac.length).toBeGreaterThan(0)
		expect(
			onMac.filter(
				(file) => file.startsWith("tests/integration/postgres/") || reachesPg(readFileSync(join(CORE, file), "utf8")),
			),
		).toEqual([])
	})
})
