/**
 * P1 ⊃ P2 of r20, amended: check's and baseline's replay runs each history file as Atlas applies it,
 * committed, in a database made for it on devUrl's server and dropped after. Here dev and target
 * share one server, as this suite's do and many setups' do: a statement whose scope is the server or
 * another database leaves the target, its roles and other databases as they were, a CREATE ROLE runs
 * and its role is dropped after, and what a killed run left is swept an hour on. devUrl's role needs
 * CREATEDB, and devUrl's extensions are copied into the replay's database.
 */
import { randomBytes } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pg from "pg"
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { approveMigration } from "../../../src/migrate/core/approval.ts"
import { applyWithAtlas, baselineWithAtlas } from "../../../src/migrate/core/atlas-apply.ts"
import { hashDir } from "../../../src/migrate/core/atlas-dir.ts"
import { loadPostgresParser } from "../../../src/migrate/core/pg-parser.ts"
import { run } from "../../../src/migrate/core/process.ts"
import type { ParsedMigration } from "../../../src/migrate/types.ts"
import { pgUrl, withScratchDb } from "../support/pg.ts"

beforeAll(loadPostgresParser)

let dir = ""
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "comb-pg-replay-db-"))
})
afterEach(() => rmSync(dir, { force: true, recursive: true }))

/** The rows `sql` returns on the database at `url` */
async function query(url: string, sql: string): Promise<Array<Record<string, unknown>>> {
	const client = new pg.Client({ connectionString: url })
	await client.connect()
	try {
		return (await client.query(sql)).rows as Array<Record<string, unknown>>
	} finally {
		await client.end()
	}
}

/** Each of `statements` on the server, one query apiece, as CREATE and DROP DATABASE need */
async function onServer(...statements: string[]): Promise<void> {
	for (const sql of statements) await query(pgUrl(), sql)
}

/** A name no other test or run holds */
const unique = (prefix: string) => `${prefix}_${randomBytes(4).toString("hex")}`

/** The files, named in order and hashed, in `at` */
function write(files: readonly string[], at = dir): void {
	files.forEach((sql, i) => writeFileSync(join(at, `20260101${String(i).padStart(6, "0")}_f${i}.sql`), sql))
	hashDir(run, at)
}

/** A check of every file against the empty target at `url`: what it printed, and why it refused */
async function check(devUrl: string, url: string, at = dir): Promise<{ out: string[]; refused?: string | undefined }> {
	const out: string[] = []
	try {
		await applyWithAtlas({
			approve: (m: ParsedMigration) => approveMigration(m, { target: "core", yes: true }),
			checkOnly: true,
			dir: at,
			print: (line) => out.push(line),
			target: { devUrl, lockTimeout: "5s", schema: "public", url },
		})
		return { out }
	} catch (error) {
		return { out, refused: (error as Error).message }
	}
}

/** devUrl as `role`, made with `attributes` and the URL's own password, which CI's server checks */
async function asRole(devUrl: string, role: string, attributes: string): Promise<string> {
	const password = decodeURIComponent(new URL(devUrl).password).replaceAll("'", "''")
	await query(devUrl, `CREATE ROLE ${role} LOGIN ${attributes} PASSWORD '${password}'`)
	const url = new URL(devUrl)
	url.username = role
	return url.toString()
}

const dropRoles = (...roles: string[]) => query(pgUrl(), `DROP ROLE IF EXISTS ${roles.join(", ")}`)

/** Resolves once `role` exists on the server */
async function untilRole(role: string): Promise<void> {
	for (;;) {
		if ((await roleOf(role)).length > 0) return
		await new Promise((resolve) => setTimeout(resolve, 20))
	}
}

/** The settings an ALTER DATABASE left on `target` */
const settingsOf = (target: string) =>
	query(
		pgUrl(),
		`SELECT 1 FROM pg_db_role_setting s JOIN pg_database d ON d.oid = s.setdatabase WHERE d.datname = '${target}'`,
	)

/** `role` on the server, with its connection limit, if it exists */
const roleOf = (role: string) => query(pgUrl(), `SELECT rolname, rolconnlimit FROM pg_roles WHERE rolname = '${role}'`)

/** The line check prints for `sent`, in the `index`th history file, left out as `what` */
const left = (sent: string, index: number, what: string) =>
	`Check left ${JSON.stringify(sent)} in 2026010100000${index}_f${index}.sql out of its replay on devUrl: ${what} reaches past the database the replay runs in, so apply alone runs it`

describe("the replay on a server dev and target share leaves what lies past its database as it was", () => {
	it("leaves out roles' changes, other databases, ALTER SYSTEM and the target's settings, names them, and runs CREATE ROLE", async () => {
		const [made, pre, other] = [unique("comb_t_made"), unique("comb_t_pre"), unique("comb_t_other")]
		await onServer(`CREATE ROLE ${pre} NOLOGIN`, `CREATE DATABASE ${other}`)
		try {
			await withScratchDb((dev) =>
				withScratchDb(async (url) => {
					const target = new URL(url).pathname.slice(1)
					write([
						`-- comb:allow-unsafe: the test's history\nCREATE ROLE ${made};\nCREATE TABLE t (id int PRIMARY KEY);\nALTER TABLE t ENABLE ROW LEVEL SECURITY;\nCREATE POLICY p ON t TO ${made} USING (true);\nALTER ROLE ${pre} CONNECTION LIMIT 7;\nALTER DATABASE ${target} SET work_mem = '8MB';\n`,
						`-- atlas:txmode none\n\n-- comb:allow-unsafe: the test's history\nALTER SYSTEM SET work_mem = '9MB';\nDROP DATABASE ${other};\n`,
					])
					for (const round of [1, 2]) {
						const { out, refused } = await check(dev, url)
						expect(refused, `round ${round}`).toBeUndefined()
						expect(out.filter((line) => line.startsWith("Check left"))).toEqual([
							left(`ALTER ROLE ${pre} CONNECTION LIMIT 7`, 0, "ALTER ROLE"),
							left(`ALTER DATABASE ${target} SET work_mem = '8MB'`, 0, "ALTER DATABASE"),
							left("ALTER SYSTEM SET work_mem = '9MB'", 1, "ALTER SYSTEM"),
							left(`DROP DATABASE ${other}`, 1, "DROP DATABASE"),
						])
					}
					expect(await settingsOf(target)).toEqual([])
					expect(await roleOf(pre)).toEqual([{ rolconnlimit: -1, rolname: pre }])
					expect(await roleOf(made)).toEqual([])
					expect(await query(url, `SELECT datname FROM pg_database WHERE datname = '${other}'`)).toEqual([
						{ datname: other },
					])
					expect(
						await query(url, "SELECT 1 FROM pg_file_settings WHERE name = 'work_mem' AND setting = '9MB'"),
					).toEqual([])
				}),
			)
		} finally {
			await onServer(`DROP DATABASE IF EXISTS ${other}`)
			await dropRoles(pre, made)
		}
	}, 120_000)
})

describe("baseline's replay, and two at once, on a server dev and target share", () => {
	it("baselines a target those files built, leaving the same statements out", async () => {
		const [made, pre] = [unique("comb_t_made"), unique("comb_t_pre")]
		await query(pgUrl(), `CREATE ROLE ${pre} NOLOGIN; CREATE ROLE ${made} NOLOGIN`)
		try {
			await withScratchDb((dev) =>
				withScratchDb(async (url) => {
					const target = new URL(url).pathname.slice(1)
					const tables = `CREATE TABLE t (id int PRIMARY KEY);\nALTER TABLE t ENABLE ROW LEVEL SECURITY;\nCREATE POLICY p ON t TO ${made} USING (true);\n`
					await query(url, tables)
					write([
						`CREATE ROLE ${made};\n${tables}ALTER ROLE ${pre} CONNECTION LIMIT 7;\nALTER DATABASE ${target} SET work_mem = '8MB';\n`,
					])
					await baselineWithAtlas({
						dir,
						print: () => undefined,
						target: { devUrl: dev, lockTimeout: "5s", schema: "public", url },
					})
					expect(await roleOf(pre)).toEqual([{ rolconnlimit: -1, rolname: pre }])
					/* the role existed, so the replay used it and dropped nothing */
					expect(await roleOf(made)).toEqual([{ rolconnlimit: -1, rolname: made }])
					expect(await settingsOf(target)).toEqual([])
				}),
			)
		} finally {
			await dropRoles(pre, made)
		}
	}, 120_000)

	it("passes two replays at once whose history creates one role, and drops it after both", async () => {
		const made = unique("comb_t_made")
		try {
			await withScratchDb((dev) =>
				withScratchDb(async (url) => {
					write([
						`-- comb:allow-unsafe: the test's history\nCREATE ROLE ${made};\nCREATE TABLE t (id int PRIMARY KEY);\nALTER TABLE t ENABLE ROW LEVEL SECURITY;\nCREATE POLICY p ON t TO ${made} USING (true);\n`,
					])
					const both = await Promise.all([check(dev, url), check(dev, url)])
					expect(both.map(({ refused }) => refused)).toEqual([undefined, undefined])
					expect(await roleOf(made)).toEqual([])
				}),
			)
		} finally {
			await dropRoles(made)
		}
	}, 120_000)
})

describe("the replay's sweep", () => {
	it("drops what a killed run left an hour ago, and keeps a younger run's and every untagged role", async () => {
		const hourAgo = Date.now() - 61 * 60_000
		const [leaked, young] = [`comb_replay_${hourAgo}_${unique("t")}`, `comb_replay_${Date.now()}_${unique("t")}`]
		const [stale, fresh, untagged] = [unique("comb_t_stale"), unique("comb_t_fresh"), unique("comb_replay_untagged")]
		await onServer(
			`CREATE DATABASE ${leaked}`,
			`CREATE DATABASE ${young}`,
			`CREATE ROLE ${stale}; CREATE ROLE ${fresh}; CREATE ROLE ${untagged}; COMMENT ON ROLE ${stale} IS 'comb_replay ${hourAgo}'; COMMENT ON ROLE ${fresh} IS 'comb_replay ${Date.now()}'`,
		)
		try {
			await withScratchDb((dev) =>
				withScratchDb(async (url) => {
					write(["CREATE TABLE t (id int PRIMARY KEY);\n"])
					expect((await check(dev, url)).refused).toBeUndefined()
				}),
			)
			const names = (
				await query(pgUrl(), `SELECT datname FROM pg_database WHERE datname IN ('${leaked}', '${young}')`)
			).map((row) => row["datname"])
			expect(names).toEqual([young])
			const roles = await query(
				pgUrl(),
				`SELECT rolname FROM pg_roles WHERE rolname IN ('${stale}', '${fresh}', '${untagged}') ORDER BY rolname`,
			)
			expect(roles.map((row) => row["rolname"])).toEqual([fresh, untagged].sort())
		} finally {
			await onServer(`DROP DATABASE IF EXISTS ${leaked}`, `DROP DATABASE IF EXISTS ${young}`)
			await dropRoles(stale, fresh, untagged)
		}
	}, 120_000)
})

describe("the replay's database", () => {
	it("refuses a devUrl role without CREATEDB, naming the privilege", async () => {
		const role = unique("comb_t_nocreatedb")
		try {
			const refused = await withScratchDb(async (dev) => {
				const as = await asRole(dev, role, "NOCREATEDB")
				return withScratchDb(async (url) => {
					write(["CREATE TABLE t (id int PRIMARY KEY);\n"])
					return (await check(as, url)).refused
				})
			})
			expect(refused).toMatch(/^devUrl's role cannot create a database \(CREATEDB\)/)
		} finally {
			await dropRoles(role)
		}
	}, 60_000)

	it("copies devUrl's extensions in their schema, and refuses naming one it cannot make", async () => {
		const role = unique("comb_t_creator")
		try {
			await withScratchDb(async (dev) => {
				await query(dev, "CREATE SCHEMA ext; CREATE EXTENSION citext WITH SCHEMA ext VERSION '1.5'")
				await withScratchDb(async (url) => {
					write(["CREATE TABLE person (id int PRIMARY KEY, mail ext.citext);\n"])
					expect((await check(dev, url)).refused).toBeUndefined()
					await query(dev, "CREATE EXTENSION pageinspect")
					const as = await asRole(dev, role, "CREATEDB")
					expect((await check(as, url)).refused).toMatch(
						/^devUrl's database holds the extension pageinspect, which comb could not make in the database it replays the history in: permission denied to create extension "pageinspect"/,
					)
				})
			})
		} finally {
			await dropRoles(role)
		}
	}, 60_000)
})

/* R1 of the P1 review: a replay that made a role holds it as one that reused it does, so a shorter
   replay ending first never drops the role from under a later file of the longer one */
describe("two replays at once, one paused between the file making a role and the file using it", () => {
	it("passes both, and drops the role after both", async () => {
		const [made, resume] = [unique("comb_t_made"), unique("comb_t_resume")]
		const other = mkdtempSync(join(tmpdir(), "comb-pg-replay-db-b-"))
		try {
			await withScratchDb((dev) =>
				withScratchDb(async (url) => {
					const policy = `CREATE TABLE t (id int PRIMARY KEY);\nALTER TABLE t ENABLE ROW LEVEL SECURITY;\nCREATE POLICY p ON t TO ${made} USING (true);\n`
					const unsafe = "-- comb:allow-unsafe: the test's history\n"
					/* the role is the server's, so the paused replay sees the test make the one it waits for */
					const pause = `DO $$ BEGIN FOR i IN 1..1200 LOOP EXIT WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${resume}'); PERFORM pg_sleep(0.05); END LOOP; END $$;\n`
					write([`${unsafe}CREATE ROLE ${made};\n`, `${unsafe}${pause}`, `${unsafe}${policy}`])
					write([`${unsafe}CREATE ROLE ${made};\n${policy}`], other)
					const long = check(dev, url)
					await untilRole(made)
					const short = await check(dev, url, other)
					await onServer(`CREATE ROLE ${resume}`)
					expect([short.refused, (await long).refused]).toEqual([undefined, undefined])
					expect(await roleOf(made)).toEqual([])
				}),
			)
		} finally {
			rmSync(other, { force: true, recursive: true })
			await dropRoles(made, resume)
		}
	}, 120_000)
})
