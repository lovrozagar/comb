/**
 * PR5 of r22b, one rule with P6 of r21: a statement whose shared effect falls only on roles the
 * replay made runs, as their drop undoes it: a rename, ALTER ROLE and ALTER GROUP, DROP ROLE, and
 * DROP OWNED and REASSIGN OWNED, whose effect a later statement in the replay's own database needs.
 * And a statement naming a tablespace the replay left out runs in its database's default one. Apply
 * is the oracle of each case, and check leaves no role and no tablespace behind.
 * Sibling: made-role.test.ts, a change only to a made role inside a DO block (PR6).
 */
import { describe, expect, it, onTestFinished } from "vitest"
import { pgCheck, T } from "../support/pg-check.ts"
import { asRole, query, roleOf, testRoles, unique } from "../support/pg-roles.ts"
import { pgUrl } from "../support/pg.ts"

const { checked, checkThenApply, devUrl } = pgCheck()

const BOTH_PASS = { apply: undefined, check: undefined }

/** A history file's text, its change approved */
const approved = (sql: string) => `-- comb:allow-unsafe: the test's change\n${sql}`

/** Whether the server holds any of `roles` */
const anyLeft = async (roles: readonly string[]): Promise<boolean> =>
	(await Promise.all(roles.map((role) => roleOf(role)))).some((rows) => rows.length > 0)

/** `one` then `two` checked alone, leaving none of `roles`, then checked and applied on a fresh target */
async function checkedThenApplied(one: string, two: string, roles: readonly string[]) {
	const { refused } = await checked(one, two)
	expect(refused).toBeUndefined()
	expect(await anyLeft(roles)).toBe(false)
	return checkThenApply(one, two)
}

/* the next file sees the role as the replay committed it; apply runs in no replay database, so it raises nothing there */
const bareAfter = (app: string) =>
	approved(
		`DO $$ BEGIN IF current_database() LIKE 'comb\\_replay\\_%' AND (SELECT rolcanlogin OR rolsuper OR rolreplication OR rolbypassrls OR rolconnlimit <> 3 FROM pg_roles WHERE rolname = '${app}') THEN RAISE EXCEPTION 'not bare, or not altered'; END IF; END $$;\nCREATE TABLE z (id int);\n`,
	)
const altered = (app: string) =>
	`${T}CREATE ROLE ${app};\nALTER ROLE ${app} WITH LOGIN SUPERUSER REPLICATION BYPASSRLS PASSWORD 'from-the-repo' CONNECTION LIMIT 3;\nALTER ROLE ${app} SET work_mem = '8MB';\nALTER ROLE ${app} WITH LOGIN;\n`

describe("a statement on roles the replay made runs, as their drop undoes it (PR5 of r22b; sibling: P6 of r21's GRANT)", () => {
	it("checks a policy to a made role it renamed, as apply runs it", async () => {
		const [app, reader] = testRoles("comb_t_app", "comb_t_reader")
		const one = `CREATE ROLE ${app};\nCREATE TABLE p (id int);\nGRANT SELECT ON p TO ${app};\n`
		const two = approved(
			`ALTER ROLE ${app} RENAME TO ${reader};\nCREATE POLICY readers ON p FOR SELECT TO ${reader} USING (true);\n`,
		)
		expect(await checkedThenApplied(one, two, [app, reader])).toEqual(BOTH_PASS)
	}, 90_000)

	it("checks a table made again after DROP OWNED BY and DROP ROLE of a made role, as apply runs it", async () => {
		const [legacy] = testRoles("comb_t_legacy")
		const one = `CREATE ROLE ${legacy};\nCREATE TABLE q (id int);\nALTER TABLE q OWNER TO ${legacy};\n`
		const two = approved(`DROP OWNED BY ${legacy};\nDROP ROLE ${legacy};\nCREATE TABLE q (id bigint);\n`)
		expect(await checkedThenApplied(one, two, [legacy])).toEqual(BOTH_PASS)
	}, 90_000)

	it("checks DROP ROLE of a made role after REASSIGN OWNED BY it, as apply runs it", async () => {
		const [legacy] = testRoles("comb_t_legacy")
		const one = `CREATE ROLE ${legacy};\nCREATE TABLE q (id int);\nALTER TABLE q OWNER TO ${legacy};\n`
		const two = approved(
			`REASSIGN OWNED BY ${legacy} TO CURRENT_USER;\nDROP ROLE ${legacy};\nALTER TABLE q ADD COLUMN x int;\n`,
		)
		expect(await checkedThenApplied(one, two, [legacy])).toEqual(BOTH_PASS)
	}, 90_000)

	/* a file's SET ROLE leaves Atlas no right to write its revision, so the file asks Postgres for the membership */
	it("checks a membership ALTER GROUP gave a made role, as apply runs it", async () => {
		const [app, writers] = testRoles("comb_t_app", "comb_t_writers")
		const one = `CREATE ROLE ${writers};\nCREATE ROLE ${app};\n`
		const two = approved(
			`ALTER GROUP ${writers} ADD USER ${app};\nDO $$ BEGIN IF NOT pg_has_role('${app}', '${writers}', 'MEMBER') THEN RAISE EXCEPTION 'not a member'; END IF; END $$;\nCREATE TABLE w (id int);\n`,
		)
		expect(await checkedThenApplied(one, two, [app, writers])).toEqual(BOTH_PASS)
	}, 90_000)

	it("runs ALTER ROLE of a made role, which stays bare, as apply runs it as written", async () => {
		const [app] = testRoles("comb_t_app")
		expect(await checkedThenApplied(altered(app), bareAfter(app), [app])).toEqual(BOTH_PASS)
	}, 90_000)

	it("runs ALTER ROLE of a made role on a devUrl role that is not a superuser, without the attributes it may not give", async () => {
		const [app, dev] = testRoles("comb_t_app", "comb_t_dev")
		const asDev = await asRole(devUrl(), dev, "CREATEDB CREATEROLE")
		const { out, refused } = await checked(altered(app), bareAfter(app), asDev)
		expect(refused).toBeUndefined()
		expect(out).toContainEqual(expect.stringMatching(/^Check made the role of "ALTER ROLE comb_t_app_\w+ WITH LOGIN/))
		expect(await roleOf(app)).toEqual([])
	}, 90_000)
})

describe("a statement on a tablespace the replay left out runs in its database's default one (PR5 of r22b)", () => {
	it("checks a table and an index in a tablespace a txmode none file makes, as apply runs them", async () => {
		const fast = unique("comb_t_fast")
		/* apply makes it on the shared server, in place, so it needs no directory; dropped once the target is */
		onTestFinished(async () => {
			await query(pgUrl(), `DROP TABLESPACE IF EXISTS ${fast}`)
		})
		const two = `-- atlas:txmode none\n\n${approved(`SET allow_in_place_tablespaces = on;\nCREATE TABLESPACE ${fast} LOCATION '';\nCREATE TABLE hot (id int) TABLESPACE ${fast};\nCREATE INDEX hot_id ON hot (id) TABLESPACE ${fast};\n`)}`
		const { out, refused } = await checked(T, two)
		expect(refused).toBeUndefined()
		expect(out.filter((line) => line.startsWith("Check ran "))).toEqual([
			expect.stringContaining(`tablespace ${fast}`),
			expect.stringContaining(`tablespace ${fast}`),
		])
		expect(await query(pgUrl(), `SELECT 1 FROM pg_tablespace WHERE spcname = '${fast}'`)).toEqual([])
		expect(await checkThenApply(T, two)).toEqual(BOTH_PASS)
	}, 90_000)
})
