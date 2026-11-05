/**
 * The roles a dev replay makes and grants (pg-replay.ts). A role is the server's, not the
 * database's: a history's CREATE ROLE of one that exists uses it, held by a grant on the replay's
 * database so another replay cannot drop it meanwhile, and one comb creates is tagged with the
 * backend that made it and dropped after. The replay needs only a role's name, for a policy, a
 * grant or an owner, so it makes the role NOLOGIN NOSUPERUSER NOREPLICATION NOBYPASSRLS whatever
 * the history says (P3 of r21), keeping only its memberships among roles it made itself: no role
 * the history logs in as, a superuser one least of all, exists on devUrl's server while a check
 * runs. A GRANT or REVOKE of roles the replay made runs, as their drop undoes it (P6 of r21).
 *
 * A role a statement the replay cannot leave out adds, such as `DO … IF NOT EXISTS … CREATE ROLE`,
 * is adopted as one comb made when nothing else changed beside it (P5 of r22): made bare, tagged,
 * held and dropped after. And a change to a role the replay made or adopts, to its row, its
 * memberships, its settings, its comment or its labels, dies with it, so it is the replay's own,
 * the role made bare again before the COMMIT (PR6 of r22b, pg-replay-commit.ts).
 */
import { sqlIdentifier } from "../../codegen/utils/case.ts"
import { codeOf, literal, type Sql, TAG } from "./pg-replay-database.ts"
import { addWrites, catalogsOf, counts, type Rows, subjectRows, type Writes, writesSince } from "./pg-server-writes.ts"
import type { Snapshot, Strays } from "./pg-server-snapshot.ts"

/**
 * One replay's state: its connection, the server as committed (`admin`), its database, the backend
 * that owns it, its role (`role`, which CURRENT_USER and its kin name in a file), whether that role
 * is a superuser, which reads pg_authid, and the roles it made; the
 * open transaction's own writes, comb's CREATE ROLEs', with the rows they left; the shared catalogs
 * as last read committed (`seen`), and the roles, databases and replication slots a refused window
 * added (`strays`), which the cleanup drops
 */
type Run = {
	admin: Sql
	created: string[]
	database: string
	ours: { rows: Rows; writes: Writes }
	owner: string
	role: string
	seen: Snapshot
	sql: Sql
	strays: Strays
	superuser: boolean
}

/** The role `sql` runs as, which CURRENT_USER and its kin name in a file, and whether it is a superuser */
async function devRoleOf(sql: Sql): Promise<{ role: string; superuser: boolean }> {
	const [row] = await sql.unsafe("SELECT rolname, rolsuper FROM pg_roles WHERE rolname = current_user", [])
	return { role: String(row?.["rolname"] ?? ""), superuser: row?.["rolsuper"] === true }
}

/** `act` run, its writes to the shared catalogs counted as comb's own, with the rows of them that are `mine` */
async function own(run: Run, act: () => Promise<void>, mine: (subject: string) => boolean): Promise<void> {
	const before = (await counts(run.sql)).writes
	await act()
	const written = writesSince((await counts(run.sql)).writes, before)
	addWrites(run.ours.writes, written)
	const read = { catalogs: catalogsOf(run.superuser), sql: run.sql }
	for (const [subject, row] of await subjectRows(read, written, mine)) run.ours.rows.set(subject, row)
}

/* the options a replay keeps of a CREATE ROLE, each a membership, by the clause that writes it */
// lookup-table: a CREATE ROLE's membership options, by the parse tree's name for each
const MEMBERSHIPS: Readonly<Record<string, string>> = {
	addroleto: "IN ROLE",
	adminmembers: "ADMIN",
	rolemembers: "ROLE",
}

/* the attributes every role a replay makes has, each the default of its option but LOGIN's under CREATE USER */
const BARE = "NOLOGIN NOSUPERUSER NOREPLICATION NOBYPASSRLS"

// lookup-table: the options BARE already says, each spelled as the parse tree holds it
const SAID: ReadonlySet<string> = /* @__PURE__ */ new Set(["bypassrls", "canlogin", "isreplication", "superuser"])

type Option = {
	DefElem: {
		arg?:
			| { Boolean?: { boolval?: boolean | undefined } | undefined; List?: { items: RoleSpec[] } | undefined }
			| undefined
		defname: string
	}
}
type RoleSpec = { RoleSpec: { rolename?: string | undefined; roletype: string } }

/**
 * The CREATE ROLE a replay runs for a history's `node`: the role with BARE's attributes and the
 * memberships among roles in `made`; `whole` when it leaves out nothing the history said
 */
function bareRole(
	node: Record<string, unknown>,
	made: readonly string[],
): { sql: string; whole: boolean; within: string[] } {
	const clauses: string[] = []
	const within: string[] = []
	let whole = node["stmt_type"] !== "ROLESTMT_USER"
	for (const { DefElem } of (node["options"] ?? []) as Option[]) {
		const clause = MEMBERSHIPS[DefElem.defname]
		if (clause === undefined) {
			whole &&= SAID.has(DefElem.defname) && DefElem.arg?.Boolean?.boolval !== true
			continue
		}
		/* a membership option names its roles as a list, always */
		const specs = (DefElem.arg as { List: { items: RoleSpec[] } }).List.items.map(({ RoleSpec }) => RoleSpec)
		const names = specs.map((spec) => spec.rolename ?? "")
		if (specs.every((spec) => spec.roletype === "ROLESPEC_CSTRING" && made.includes(spec.rolename as string))) {
			clauses.push(` ${clause} ${names.map(sqlIdentifier).join(", ")}`)
			if (DefElem.defname === "addroleto") within.push(...names)
		} else whole = false
	}
	return { sql: `CREATE ROLE ${sqlIdentifier(String(node["role"]))} ${BARE}${clauses.join("")}`, whole, within }
}

/**
 * The CREATE ROLE `sent` of `role`, run in the replay's `database`: an existing role is used, any
 * other made by `sent` and tagged with its `owner`, and either held by a grant on `database`;
 * whether the role is a replay's, which the replay then drops, so whichever of two replays using
 * one role ends last drops it. It runs in a transaction, as every statement a transaction allows
 * does (P1 of r21), and each try is a savepoint, so a role another replay made or dropped since the
 * read is read again
 */
async function createRole(
	sql: Sql,
	{ database, owner, role, sent }: { database: string; owner: string; role: string; sent: string },
): Promise<boolean> {
	const mark = (query: string) => sql.unsafe(query, [])
	for (;;) {
		const [found] = await sql.unsafe(
			"SELECT d.description FROM pg_roles r LEFT JOIN pg_shdescription d ON d.objoid = r.oid AND d.classoid = 'pg_authid'::regclass WHERE r.rolname = $1",
			[role],
		)
		const exists = found !== undefined
		await mark("SAVEPOINT comb_role")
		try {
			if (!exists) {
				await sql.unsafe(sent, [])
				await sql.unsafe(`COMMENT ON ROLE ${sqlIdentifier(role)} IS ${literal(`${TAG} ${owner}`)}`, [])
			}
			/* the replay that made the role holds it too, so whichever replay using it ends last drops it */
			await sql.unsafe(`GRANT CONNECT ON DATABASE ${database} TO ${sqlIdentifier(role)}`, [])
			await mark("RELEASE SAVEPOINT comb_role")
			return !exists || String(found["description"]).startsWith(`${TAG} `)
		} catch (error) {
			const raced = exists ? codeOf(error) === "42704" : codeOf(error) === "42710" || codeOf(error) === "23505"
			if (!raced) throw error
			// reason: another replay dropped the role, or made it, since the read: read it again
			await mark("ROLLBACK TO SAVEPOINT comb_role")
		}
	}
}

/**
 * A history CREATE ROLE of `node` run bare: the role, its tag, the memberships it keeps and the
 * grant on the replay's database; whether the replay made it without some of what the history said
 */
async function ownRole(run: Run, node: Record<string, unknown>): Promise<boolean> {
	const role = String(node["role"])
	const { sql: sent, whole, within } = bareRole(node, run.created)
	let made = false
	await own(
		run,
		async () => {
			made = await createRole(run.sql, { ...run, role, sent })
			if (made) run.created.push(role)
		},
		(subject) =>
			subject === `role ${role}` ||
			subject === `comment on role ${role}` ||
			[role, ...within].some((each) => subject.startsWith(`membership ${each} to `)) ||
			subject === `database ${run.database}`,
	)
	return made && !whole
}

/* the roles a GRANT or REVOKE of a role names; a membership in one the replay made dies with it (P6 of r21) */
const grantedOf = (node: Record<string, unknown>): string[] =>
	(node["granted_roles"] as Array<{ AccessPriv: { priv_name: string } }>).map(({ AccessPriv }) => AccessPriv.priv_name)

/** Whether `type` is a GRANT or REVOKE of roles this replay made alone, which it runs, as their drop undoes it */
const grantsMade = (run: Run, type: string, node: Record<string, unknown>): boolean =>
	type === "GrantRoleStmt" && grantedOf(node).every((role) => run.created.includes(role))

/** A history GRANT or REVOKE of roles this replay made: the memberships in them are comb's own */
const ownGrant = (run: Run, node: Record<string, unknown>, sent: string): Promise<void> =>
	own(
		run,
		async () => {
			await run.sql.unsafe(sent, [])
		},
		(subject) => grantedOf(node).some((role) => subject.startsWith(`membership ${role} to `)),
	)

/**
 * `roles` of the replay's, changed in its open transaction, made bare again before it commits: no
 * login, no password, and none of the attributes BARE denies, each said only where the role has it,
 * as a role that is not a superuser may not name one it lacks (PR6 of r22b)
 */
async function bareAgain(run: Run, roles: readonly string[]): Promise<void> {
	if (roles.length === 0) return
	const rows = await run.sql.unsafe(
		"SELECT rolname, rolsuper, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = ANY($1::text[])",
		[[...roles]],
	)
	for (const row of rows) {
		const denied = [
			row["rolsuper"] === true ? " NOSUPERUSER" : "",
			row["rolreplication"] === true ? " NOREPLICATION" : "",
			row["rolbypassrls"] === true ? " NOBYPASSRLS" : "",
		].join("")
		await run.sql.unsafe(`ALTER ROLE ${sqlIdentifier(String(row["rolname"]))} NOLOGIN${denied} PASSWORD NULL`, [])
	}
}

/**
 * `roles` the open transaction added, adopted as the replay's own before it commits (P5 of r22):
 * tagged with its owner, held by a grant on its database, and dropped with the roles it made
 */
async function adopt(run: Run, roles: readonly string[]): Promise<void> {
	for (const role of roles) {
		await run.sql.unsafe(`COMMENT ON ROLE ${sqlIdentifier(role)} IS ${literal(`${TAG} ${run.owner}`)}`, [])
		await run.sql.unsafe(`GRANT CONNECT ON DATABASE ${run.database} TO ${sqlIdentifier(role)}`, [])
		run.created.push(role)
	}
}

/* the roles of a list the server holds but those a replay made and tagged, which it drops after itself (P7 of r21) */
const HELD = `SELECT r.rolname FROM pg_roles r LEFT JOIN pg_shdescription d ON d.objoid = r.oid AND d.classoid = 'pg_authid'::regclass WHERE r.rolname = ANY($1::text[]) AND (d.description IS NULL OR d.description NOT LIKE 'comb\\_replay %')`

/** Which of `roles` the server holds, a replay's own left out: another replay's role is gone once it ends */
async function heldRoles(sql: Sql, roles: readonly string[]): Promise<Set<string>> {
	return new Set((await sql.unsafe(HELD, [[...roles]])).map((row) => String(row["rolname"])))
}

export { adopt, bareAgain, bareRole, createRole, devRoleOf, grantsMade, heldRoles, ownGrant, ownRole, type Run }
