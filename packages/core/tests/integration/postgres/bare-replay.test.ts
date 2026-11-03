/**
 * P1 and P2 of r22: Atlas sends a `-- atlas:txmode none` file's statements bare, so check's replay
 * does, and a change past the replay's database that a second backend commits, which this backend's
 * counts never see, is read from the server's committed catalogs and is the file's when it is to an
 * object the file names. apply on one server is the oracle.
 */
import { rmSync } from "node:fs"
import { afterEach, describe, expect, it } from "vitest"
import { applyWithAtlas } from "../../../src/migrate/core/atlas-apply.ts"
import { pgCheck, T, tempDir } from "../support/pg-check.ts"
import { pgUrl, withScratchDb } from "../support/pg.ts"
import { dropRoles, LOOPBACK, query, roleOf, unique } from "../support/pg-roles.ts"

const { checked, checkThenApply, devUrl, dir, files, options } = pgCheck()

/* a txmode none file's head, its change approved */
const NONE = "-- atlas:txmode none\n\n-- comb:allow-unsafe: the test's change\n"

/* P1 of r22: Atlas sends a txmode none file's statements bare; 0.20 wrapped each in BEGIN/COMMIT, so a batched
   backfill's COMMIT failed check and passed apply, and a LOCK TABLE passed check and failed apply */
describe("a txmode none file replays bare, as Atlas sends it (P1; sibling: r21 P1's per-statement BEGIN)", () => {
	const HEAD = `${T}INSERT INTO t (id) SELECT g FROM generate_series(1, 2500) g;\nCREATE PROCEDURE backfill() LANGUAGE plpgsql AS $$ BEGIN LOOP UPDATE t SET w = 1 WHERE id IN (SELECT id FROM t WHERE w IS NULL LIMIT 1000); EXIT WHEN NOT FOUND; COMMIT; END LOOP; END $$;\n`
	it.each([
		[
			"a DO block that commits per batch",
			"DO $$ BEGIN LOOP UPDATE t SET w = 1 WHERE id IN (SELECT id FROM t WHERE w IS NULL LIMIT 1000); EXIT WHEN NOT FOUND; COMMIT; END LOOP; END $$;\n",
		],
		["a CALL of a procedure that commits per batch", "CALL backfill();\n"],
		/* each statement runs in a guarded transaction first: the file's own block, and a cursor kept past one, still run bare */
		[
			"a file that opens its own transaction, locking and saving inside it",
			"BEGIN;\nLOCK TABLE t IN SHARE MODE;\nSAVEPOINT s;\nUPDATE t SET w = 2;\nRELEASE s;\nCOMMIT;\n",
		],
		["a cursor declared WITH HOLD", "DECLARE c CURSOR WITH HOLD FOR SELECT id FROM t;\nCLOSE c;\n"],
	])(
		"passes %s, as apply runs it",
		async (_, body) => {
			expect(await checkThenApply(HEAD, `${NONE}${body}`)).toEqual({ apply: undefined, check: undefined })
		},
		60_000,
	)

	it.each([
		[
			"LOCK TABLE",
			"LOCK TABLE t IN SHARE MODE;\nUPDATE t SET w = 2;\n",
			"LOCK TABLE can only be used in transaction blocks",
		],
		["SAVEPOINT", "SAVEPOINT s;\nUPDATE t SET w = 2;\n", "SAVEPOINT can only be used in transaction blocks"],
		["RELEASE", "RELEASE s;\n", "RELEASE SAVEPOINT can only be used in transaction blocks"],
		["ROLLBACK TO", "ROLLBACK TO s;\n", "ROLLBACK TO SAVEPOINT can only be used in transaction blocks"],
		[
			"DECLARE without HOLD",
			"DECLARE c CURSOR FOR SELECT id FROM t;\n",
			"DECLARE CURSOR can only be used in transaction blocks",
		],
	])(
		"refuses %s outside a block at check, as apply refuses it",
		async (_, body, said) => {
			const { apply, check } = await checkThenApply(HEAD, `${NONE}${body}`)
			expect(check).toContain(said)
			expect(apply).toContain(said)
		},
		60_000,
	)
})

/* the amendment to P1 of r22: bare, a change past the database commits before any read sees it, so each
   statement runs in a transaction of its own first, and its counts refuse that change uncommitted */
describe("a txmode none file's statement runs in a transaction of its own first (P1 amendment; sibling: a DO's ALTER ROLE)", () => {
	it("refuses a DO that makes a role, naming it, and leaves no role behind", async () => {
		const made = unique("comb_t_bare")
		try {
			const { refused: check } = await checked(T, `${NONE}DO $$ BEGIN CREATE ROLE ${made}; END $$;\n`)
			expect({ check, role: await roleOf(made) }).toEqual({
				check: expect.stringContaining(`role ${made} added`),
				role: [],
			})
		} finally {
			await dropRoles(made)
		}
	}, 60_000)
})

/** The databases of the server named `name` */
const databaseOf = (name: string) => query(pgUrl(), `SELECT datname FROM pg_database WHERE datname = '${name}'`)

/* P2 of r22: a second backend's write is committed by it, so the replay's own counts never see it; the server's
   committed catalogs, read around each file and each bare statement, do */
describe("a second backend's change is the file's (P2; sibling: P1's bare path)", () => {
	const DBLINK = "-- comb:allow-unsafe: the test's history\nCREATE EXTENSION IF NOT EXISTS dblink;\n"
	const [side, svc] = [unique("comb_t_side"), unique("comb_t_svc")]
	afterEach(async () => {
		await query(pgUrl(), `DROP DATABASE IF EXISTS ${side} WITH (FORCE)`)
		await dropRoles(svc)
	})
	const idiom = `DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_database WHERE datname = '${side}') THEN PERFORM dblink_exec(${LOOPBACK}, 'CREATE DATABASE ${side}'); END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${svc}') THEN PERFORM dblink_exec(${LOOPBACK}, 'CREATE ROLE ${svc} LOGIN PASSWORD ''from-the-repo'''); END IF;
END $$;\n`

	it.each([
		["a txmode none file", "-- atlas:txmode none\n\n"],
		["a file in a transaction", ""],
	])(
		"refuses dblink_exec's CREATE DATABASE and CREATE ROLE in %s, naming both, and leaves neither",
		async (_, mode) => {
			const { refused } = await checked(`${T}${DBLINK}`, `${mode}-- comb:allow-unsafe: the test's change\n${idiom}`)
			expect(refused).toContain(`database ${side} added`)
			expect(refused).toContain(`role ${svc} added`)
			expect({ database: await databaseOf(side), role: await roleOf(svc) }).toEqual({ database: [], role: [] })
		},
		60_000,
	)
})

/* the server's catalogs show every session's work, so only a change to an object the file names is the file's */
describe("another session's change is its own (P2; sibling: two checks on one server)", () => {
	it.each([
		["passes a role another session makes during a bare statement, which the file does not name", false],
		["refuses one the file names, as it could have made it", true],
	])(
		"%s",
		async (_, named) => {
			const other = unique("comb_t_other")
			const spelled = named ? `-- comb:allow-unsafe: the test's name\nSELECT '${other}';\n` : ""
			const pending = `-- atlas:txmode none\n\n-- comb:allow-unsafe: the test's sleep\nSELECT pg_sleep(1.5);\n${spelled}`
			try {
				const check = checked(T, pending)
				/* the other session's change lands while the replay's bare statement runs */
				for (let i = 0; i < 200; i++) {
					const [sleeping] = await query(
						pgUrl(),
						"SELECT 1 AS n FROM pg_stat_activity WHERE query = 'SELECT pg_sleep(1.5)' AND datname LIKE 'comb\\_replay\\_%'",
					)
					if (sleeping !== undefined) break
					await new Promise((tick) => setTimeout(tick, 25))
				}
				await query(pgUrl(), `CREATE ROLE ${other}`)
				const { refused } = await check
				expect(refused === undefined ? undefined : refused.includes(`role ${other} added`)).toBe(
					named ? true : undefined,
				)
			} finally {
				await dropRoles(other)
			}
		},
		60_000,
	)

	it("passes two checks on one server at once, each making a role and running bare statements", async () => {
		const roles = [unique("comb_t_one"), unique("comb_t_two")]
		const dirs = [dir(), tempDir()]
		try {
			const both = roles.map((role, i) => {
				const at = dirs[i] as string
				files(
					`${T}-- comb:allow-unsafe: the test's role\nCREATE ROLE ${role};\n`,
					`-- atlas:txmode none\n\n-- comb:allow-unsafe: the test's sleep\nSELECT pg_sleep(0.5);\nGRANT SELECT ON t TO ${role};\nSELECT pg_sleep(0.5);\n`,
					at,
				)
				return withScratchDb((url) =>
					applyWithAtlas({ ...options({ devUrl: devUrl(), url }, [], at), checkOnly: true }).then(
						() => undefined,
						(error: Error) => error.message,
					),
				)
			})
			expect(await Promise.all(both)).toEqual([undefined, undefined])
		} finally {
			rmSync(dirs[1] as string, { force: true, recursive: true })
			await dropRoles(...roles)
		}
	}, 60_000)
})
