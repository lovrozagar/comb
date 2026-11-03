/**
 * P5 of r22 and PR6 of r22b, one rule with P3: a change whose subject is what the replay drops is the
 * replay's own. A role the replay made, or one the counted transaction adds and changes nothing else
 * beside (the idempotent `DO … IF NOT EXISTS … CREATE ROLE`), is dropped after the replay, and with it
 * its row, its memberships either way, its settings, its comment and its security labels; the replay
 * makes each bare again before COMMIT, so no role it touched logs in while a check runs. apply is the
 * oracle. A change to a role the replay did not make, a role a second connection makes (P2), and a
 * password a non-superuser devUrl cannot read stay refused.
 */
import { afterEach, describe, expect, it } from "vitest"
import { pgCheck, T } from "../support/pg-check.ts"
import { asRole, dropRoles, heldRole, LOOPBACK, query, roleOf, unique } from "../support/pg-roles.ts"
import { pgUrl } from "../support/pg.ts"

const { checked, checkThenApply, devUrl } = pgCheck()

/** A history file's text, its change approved */
const approved = (sql: string) => `-- comb:allow-unsafe: the test's change\n${sql}`

describe("a role a DO block adds is adopted as the replay's own (P5; sibling: a CREATE ROLE comb tags)", () => {
	const reader = unique("comb_t_reader")
	afterEach(() => dropRoles(reader))
	const idiom = `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${reader}') THEN CREATE ROLE ${reader}; END IF; END $$;\nGRANT SELECT ON t TO ${reader};\n`

	it("passes the idempotent idiom when devUrl's server lacks the role, naming it once, and leaves no role", async () => {
		const { out, refused } = await checked(T, approved(idiom))
		expect(refused).toBeUndefined()
		expect(out.filter((line) => line.startsWith("Check adopted role "))).toEqual([
			expect.stringMatching(new RegExp(`^Check adopted role ${reader}, which 20260102000000_two\\.sql made`)),
		])
		expect(await roleOf(reader)).toEqual([])
	}, 60_000)

	it("passes it as an applied file, on a later check whose server lacks the role", async () => {
		const { refused } = await checked(`${T}${approved(idiom)}`, "CREATE TABLE z (id int);\n")
		expect(refused).toBeUndefined()
		expect(await roleOf(reader)).toEqual([])
	}, 60_000)

	it("passes it with apply as the oracle", async () => {
		expect(await checkThenApply(T, approved(idiom))).toEqual({ apply: undefined, check: undefined })
	}, 60_000)

	it("makes a DO's LOGIN SUPERUSER REPLICATION BYPASSRLS role with a password bare before its file commits, as apply makes it as written", async () => {
		const made = approved(
			`${T}DO $$ BEGIN CREATE ROLE ${reader} LOGIN SUPERUSER REPLICATION BYPASSRLS PASSWORD 'from-the-repo'; END $$;\n`,
		)
		/* the next file sees the role as the replay committed it; apply runs in no replay database, so it raises nothing there */
		const bare = approved(
			`DO $$ BEGIN IF current_database() LIKE 'comb\\_replay\\_%' AND (SELECT rolcanlogin OR rolsuper OR rolreplication OR rolbypassrls OR rolpassword IS NOT NULL FROM pg_authid WHERE rolname = '${reader}') THEN RAISE EXCEPTION 'not bare'; END IF; END $$;\nGRANT SELECT ON t TO ${reader};\n`,
		)
		expect(await checkThenApply(made, bare)).toEqual({ apply: undefined, check: undefined })
	}, 60_000)
})

describe("a change only to a role the replay made is the replay's own (PR6; sibling: P3's own database)", () => {
	const app = unique("comb_t_app")
	afterEach(() => dropRoles(app))
	const one = `CREATE ROLE ${app};\nCREATE TABLE t (id int);\n`

	it.each([
		[
			"a GRANT to CURRENT_USER through EXECUTE",
			`DO $$ BEGIN EXECUTE format('GRANT ${app} TO %I', current_user); END $$;`,
		],
		[
			"ALTER ROLE … SET through EXECUTE, the schema per environment",
			`DO $$ BEGIN EXECUTE format('ALTER ROLE ${app} SET search_path = %I', current_schema()); END $$;`,
		],
		[
			"a password from a setting, per environment",
			`DO $$ BEGIN EXECUTE format('ALTER ROLE ${app} PASSWORD %L', coalesce(current_setting('app.password', true), 'dev')); END $$;`,
		],
		["LOGIN through a DO block, made bare again", `DO $$ BEGIN ALTER ROLE ${app} LOGIN; END $$;`],
	])(
		"passes %s, as apply runs it",
		async (_, change) => {
			const two = approved(`${change}\nALTER TABLE t OWNER TO ${app};\n`)
			expect(await checkThenApply(one, two)).toEqual({ apply: undefined, check: undefined })
		},
		60_000,
	)

	it("leaves the role bare and gone after check", async () => {
		const two = approved(`DO $$ BEGIN EXECUTE format('ALTER ROLE ${app} LOGIN PASSWORD %L', 'dev'); END $$;\n`)
		expect((await checked(one, two)).refused).toBeUndefined()
		expect(await roleOf(app)).toEqual([])
	}, 60_000)
})

describe("a change past what the replay drops stays refused (P5's limits; sibling: P2's second connection)", () => {
	const [pre, made, mgr] = [unique("comb_t_pre"), unique("comb_t_made"), unique("comb_t_mgr")]
	afterEach(() => dropRoles(made, pre, mgr))

	it("refuses a DO that adds a role and changes an existing one, adopting neither, with the corrected advice", async () => {
		await query(pgUrl(), `CREATE ROLE ${pre}`)
		const held = await heldRole(pre)
		const { refused } = await checked(
			T,
			approved(`DO $$ BEGIN CREATE ROLE ${made}; ALTER ROLE ${pre} CONNECTION LIMIT 3; END $$;\n`),
		)
		expect(refused).toContain(`role ${pre} changed (rolconnlimit)`)
		expect(refused).not.toContain(`role ${made} added`)
		expect(refused).not.toContain("write the change as a statement of its own, which the replay leaves out")
		expect(refused).toContain("a CREATE ROLE runs in the replay")
		expect([await heldRole(pre), await roleOf(made)]).toEqual([held, []])
	}, 60_000)

	it("refuses a DO that changes a role the replay did not make", async () => {
		await query(pgUrl(), `CREATE ROLE ${pre}`)
		const { refused } = await checked(
			T,
			approved(`DO $$ BEGIN EXECUTE format('ALTER ROLE ${pre} SET search_path = %I', current_schema()); END $$;\n`),
		)
		expect(refused).toContain(`setting every database for ${pre} added`)
	}, 60_000)

	it("refuses a role a second connection makes, which no count sees (P2)", async () => {
		const { refused } = await checked(
			`${T}${approved("CREATE EXTENSION IF NOT EXISTS dblink;\n")}`,
			approved(`DO $$ BEGIN PERFORM dblink_exec(${LOOPBACK}, 'CREATE ROLE ${made}'); END $$;\n`),
		)
		expect(refused).toContain(`role ${made} added`)
		expect(await roleOf(made)).toEqual([])
	}, 60_000)

	it("refuses a made role's password under a devUrl role that is not a superuser, which cannot read it", async () => {
		const dev = await asRole(devUrl(), mgr, "CREATEDB CREATEROLE")
		const { refused } = await checked(
			`CREATE ROLE ${made};\n${T}`,
			approved(`DO $$ BEGIN ALTER ROLE ${made} PASSWORD 'dev'; END $$;\n`),
			dev,
		)
		expect(refused).toContain("pg_authid, in a column pg_roles does not show, such as a password")
		expect(await roleOf(made)).toEqual([])
	}, 60_000)
})
