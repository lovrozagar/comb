/**
 * The statements on roles a dev replay made that it runs rather than leaves out, one rule with
 * the GRANT's: a statement whose shared effect falls only on roles the replay made
 * dies with their drop, so it runs, as a later statement in the replay's own database may need its
 * effect. A GRANT or REVOKE of them, a rename, ALTER ROLE, ALTER GROUP and ALTER ROLE … SET of one,
 * DROP ROLE, and DROP OWNED and REASSIGN OWNED, which change what the roles own and hold in the
 * replay's database alone. A role another database still holds, as another replay of the same
 * history uses it too, is not this replay's alone, so a statement on it but a GRANT is left out.
 *
 * ALTER ROLE runs without what the replay keeps every role it makes from: a login, a
 * password, and the attributes BARE denies, as CREATE ROLE does (pg-replay-roles.ts).
 */
import { sqlIdentifier } from "../../codegen/utils/case.ts"
import { flag, num } from "./pg-nodes.ts"
import { literal, type Sql } from "./pg-replay-database.ts"
import { own, ownRole, type Run } from "./pg-replay-roles.ts"

type Node = Record<string, unknown>
type Spec = { rolename?: string | undefined; roletype: string }

/* a role a RoleSpec names by its name, else undefined: CURRENT_USER and its kin, PUBLIC, ALL */
const named = (spec: Spec | undefined): string | undefined =>
	spec?.roletype === "ROLESPEC_CSTRING" ? spec.rolename : undefined

/* the roles a list of RoleSpecs names */
const listed = (list: unknown): Array<string | undefined> =>
	(list as Array<{ RoleSpec: Spec }>).map(({ RoleSpec }) => named(RoleSpec))

/* the roles a GRANT or REVOKE of a role names; a membership in one the replay made dies with it */
const grantedOf = (node: Node): string[] =>
	(node["granted_roles"] as Array<{ AccessPriv: { priv_name: string } }>).map(({ AccessPriv }) => AccessPriv.priv_name)

/* the options BARE already says of every role a replay makes, and a password, which ALTER ROLE runs without */
// lookup-table: by the parse tree's name, the options ALTER ROLE runs without
const CUT: ReadonlySet<string> = /* @__PURE__ */ new Set([
	"bypassrls",
	"canlogin",
	"isreplication",
	"password",
	"superuser",
])

type Option = { DefElem: { arg?: Arg | undefined; defname: string } }
type Arg = {
	Boolean?: { boolval?: boolean | undefined } | undefined
	Integer?: { ival?: number | undefined } | undefined
	String?: { sval: string } | undefined
}

/* each spelled as a role the replay keeps may say it, by the clause that writes it */
const said = (yes: string) => (arg: Arg | undefined) => `${flag(arg?.Boolean?.boolval) ? "" : "NO"}${yes}`
// lookup-table: by the parse tree's name, the clause each option ALTER ROLE keeps is written with
const KEPT: Readonly<Record<string, (arg: Arg | undefined) => string>> = {
	connectionlimit: (arg) => `CONNECTION LIMIT ${num(arg?.Integer?.ival)}`,
	createdb: /* @__PURE__ */ said("CREATEDB"),
	createrole: /* @__PURE__ */ said("CREATEROLE"),
	inherit: /* @__PURE__ */ said("INHERIT"),
	validUntil: (arg) => `VALID UNTIL ${literal(String(arg?.String?.sval))}`,
}

/**
 * The ALTER ROLE the replay runs for `node`, sent as `sent`: `sent` itself when it says nothing the
 * replay runs without, else the options it keeps, or no statement when it keeps none; `bare` when
 * it said a login, a password or an attribute BARE denies, which the replay ran without
 */
function alterBare(node: Node, sent: string): { bare: boolean; sql: string | undefined } {
	const options = node["options"] as Option[]
	if (!options.some(({ DefElem }) => CUT.has(DefElem.defname))) return { bare: false, sql: sent }
	const kept: string[] = []
	let bare = false
	for (const { DefElem } of options) {
		if (CUT.has(DefElem.defname)) {
			bare ||= DefElem.defname === "password" ? DefElem.arg !== undefined : flag(DefElem.arg?.Boolean?.boolval)
			continue
		}
		const clause = KEPT[DefElem.defname]
		/* ALTER ROLE's grammar has no other option beside these, and ALTER GROUP's rolemembers none beside it */
		if (clause === undefined) throw new Error(`comb does not know ALTER ROLE's option ${DefElem.defname}`)
		kept.push(clause(DefElem.arg))
	}
	const role = sqlIdentifier(String((node["role"] as Spec).rolename))
	return { bare, sql: kept.length === 0 ? undefined : `ALTER ROLE ${role} WITH ${kept.join(" ")}` }
}

/* the made roles a list names, each a name, as runsOnMade let only those through */
const madeIn = (list: unknown): string =>
	listed(list)
		.map((role) => sqlIdentifier(String(role)))
		.join(", ")

/** `query` run on the replay's connection */
const send = async (sql: Sql, query: string): Promise<void> => {
	await sql.unsafe(query, [])
}

/** How the replay runs a statement on roles it made: the roles whose drop takes its shared effect with it, and its run, whether that ran without some of what the history said */
type Made = {
	roles: (node: Node) => ReadonlyArray<string | undefined> | undefined
	run: (run: Run, node: Node, sent: string) => Promise<boolean>
}

/** `sent` run as it is */
const asSent = async (run: Run, _: Node, sent: string): Promise<boolean> => {
	await send(run.sql, sent)
	return false
}

/**
 * By a statement's type, how the replay runs it on roles it made. DROP ROLE first gives up the
 * replay's hold on its database, which would keep the role, and DROP OWNED, which revokes it, takes
 * it again; a rename holds the role by its new name too, as the cleanup drops each of the replay's
 * roles by name, but one it did not tag
 */
// lookup-table: by a statement's type, the way the replay runs it on roles it made
const MADE: Readonly<Record<string, Made>> = {
	AlterRoleSetStmt: { roles: (node) => [named(node["role"] as Spec | undefined)], run: asSent },
	AlterRoleStmt: {
		roles: (node) => [named(node["role"] as Spec)],
		run: async (run, node, sent) => {
			const { bare, sql } = alterBare(node, sent)
			if (sql !== undefined) await send(run.sql, sql)
			return bare
		},
	},
	DropOwnedStmt: {
		roles: (node) => listed(node["roles"]),
		run: async (run, node, sent) => {
			await send(run.sql, sent)
			await send(run.sql, `GRANT CONNECT ON DATABASE ${run.database} TO ${madeIn(node["roles"])}`)
			return false
		},
	},
	DropRoleStmt: {
		roles: (node) => listed(node["roles"]),
		run: async (run, node, sent) => {
			await send(run.sql, `REVOKE CONNECT ON DATABASE ${run.database} FROM ${madeIn(node["roles"])}`)
			await send(run.sql, sent)
			return false
		},
	},
	GrantRoleStmt: { roles: grantedOf, run: asSent },
	ReassignOwnedStmt: { roles: (node) => listed(node["roles"]), run: asSent },
	RenameStmt: {
		roles: (node) => (node["renameType"] === "OBJECT_ROLE" ? [String(node["subname"])] : undefined),
		run: async (run, node, sent) => {
			await send(run.sql, sent)
			run.created.push(String(node["newname"]))
			return false
		},
	},
}
/*
 * the roles of a list another database holds, by an object there or a privilege on it, as another
 * replay holds one it uses too: pg_shdepend's rows of a role but those of the replay's own database
 */
const ELSEWHERE =
	"SELECT DISTINCT r.rolname FROM pg_shdepend s JOIN pg_roles r ON r.oid = s.refobjid WHERE s.refclassid = 'pg_authid'::regclass AND r.rolname = ANY($1::text[]) AND s.dbid <> (SELECT oid FROM pg_database WHERE datname = current_database()) AND NOT (s.classid = 'pg_database'::regclass AND s.objid = (SELECT oid FROM pg_database WHERE datname = current_database()))"

/**
 * Whether the replay runs `type` rather than leave it out: a statement on roles it made alone, and
 * but for a GRANT or REVOKE of them, on roles no other database holds
 */
async function runsOnMade(run: Run, type: string, node: Node): Promise<boolean> {
	const roles = MADE[type]?.roles(node)
	if (roles === undefined || !roles.every((role) => role !== undefined && run.created.includes(role))) return false
	if (type === "GrantRoleStmt") return true
	return (await run.sql.unsafe(ELSEWHERE, [roles])).length === 0
}

type Statement = { node: Node; sent: string; type: string }

/**
 * `sent` run by `made`, its writes to the shared catalogs comb's own, as the roles' drop undoes
 * them, with the rows of `roles`, a rename's new name and the replay's database they left
 */
async function ownMade(
	run: Run,
	{ made, roles }: { made: Made; roles: ReadonlyArray<string | undefined> },
	{ node, sent }: Statement,
): Promise<boolean> {
	const names = new Set([...roles, String(node["newname"]), run.database])
	let bare = false
	await own(
		run,
		async () => {
			bare = await made.run(run, node, sent)
		},
		(subject) => subject.split(" ").some((word) => names.has(word)),
	)
	return bare
}

/**
 * `sent` run as the replay runs a statement on roles: a history CREATE ROLE made bare, and one on
 * roles it made by MADE (ownMade); whether it ran without some of what `sent` says, and undefined
 * for any other statement, which the replay sends as it is
 */
function runRole(run: Run, statement: Statement): Promise<boolean> | undefined {
	const { node, type } = statement
	if (type === "CreateRoleStmt") return ownRole(run, node)
	const made = MADE[type]
	const roles = made?.roles(node)
	return made === undefined || roles === undefined ? undefined : ownMade(run, { made, roles }, statement)
}

export { alterBare, runRole, runsOnMade }
