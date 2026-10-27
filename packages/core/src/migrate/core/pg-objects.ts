/**
 * Postgres objects Atlas OSS will not diff: views, materialized views, policies, sequences, roles
 * and extensions ("available to logged-in users only"). comb keeps them out of what Atlas sees, as
 * it keeps FTS5 out on SQLite (fts-migration.ts): they are taken out of the history Atlas replays
 * and of the target, and comb writes their part of each migration around Atlas's statements.
 *
 * A table may still need them where Atlas works: a default may call a sequence's nextval, a column
 * may have an extension's type. So the history and target Atlas loads start with a DO block that
 * creates each sequence and extension on the dev database if it is missing (Atlas runs a DO block,
 * and its OSS inspection reads neither); they stay there, unused by anything Atlas compares.
 *
 * Before Atlas's statements: new extensions, roles (each created only if the cluster lacks it) and
 * sequences, changed sequences altered in place (dropping one would restart it), and the drops of
 * every changed or removed policy and view, and of each one over a table Atlas alters (Postgres
 * refuses to retype a column a view or policy reads), dependents first. After them: those views
 * and policies created again from the target, in its order, what was said about them again
 * (pg-extras.ts), removed sequences dropped, and each table's row level security brought to the
 * target's (pg-tables.ts). Roles and extensions are only ever added: they outlive any one schema.
 */
import { asSql } from "./fts-migration.ts"
import { affected, isView, same } from "./pg-dependents.ts"
import { extrasAfter, followExtra } from "./pg-extras.ts"
import { atlasTables, followRls, type Rls, rlsDelta, type Statement } from "./pg-tables.ts"
import { codeOf, IDENT, lastPart, QNAME, splitTopLevel } from "./sql-code.ts"
import { atlasDirectives, pgStatements } from "./pg-split.ts"
import { normalizeSql } from "./sql-scan.ts"

type PgObjectKind = "extension" | "materialized view" | "policy" | "role" | "sequence" | "view"

/** One object as a migration leaves it */
type PgObject = {
	/** the name unquoted, with its table for a policy: `post_owner on post` */
	key: string
	kind: PgObjectKind
	/** the name as written, for the statements comb writes */
	name: string
	/** a policy's table as written */
	on?: string | undefined
	/** the statement that defines it, as written */
	sql: string
	/** what later statements said about it: comments, grants, indexes (pg-extras.ts) */
	extras: string[]
}

/** What a sequence of migrations leaves of what comb owns */
type PgObjects = {
	/** the objects, by `${kind} ${key}`, in the order they were made */
	objects: Map<string, PgObject>
	/** each table's row level security, by its unquoted name */
	rls: Map<string, Rls>
}

const emptyPgObjects = (): PgObjects => ({ objects: new Map(), rls: new Map() })

type Separated = { objects: PgObject[]; plain: string[]; state: PgObjects }

// per-process-constant: the statements that make or drop a comb-owned object, composed once
const CREATE_VIEW = /* @__PURE__ */ new RegExp(
	`^CREATE (?:OR REPLACE )?(MATERIALIZED )?VIEW (?:IF NOT EXISTS )?(${QNAME})`,
	"i",
)
// per-process-constant: see above
const CREATE_POLICY = /* @__PURE__ */ new RegExp(`^CREATE POLICY (${IDENT}) ON (${QNAME})`, "i")
// per-process-constant: see above
const CREATE_NAMED = /* @__PURE__ */ new RegExp(`^CREATE (SEQUENCE|ROLE|EXTENSION) (?:IF NOT EXISTS )?(${QNAME})`, "i")
// per-process-constant: see above
const ALTER_SEQUENCE = /* @__PURE__ */ new RegExp(`^ALTER SEQUENCE (?:IF EXISTS )?(${QNAME}) (.+)$`, "is")
// per-process-constant: see above
const DROP_OBJECTS = /* @__PURE__ */ new RegExp(
	`^DROP (VIEW|MATERIALIZED VIEW|SEQUENCE|ROLE|EXTENSION) (?:IF EXISTS )?(${QNAME}(?:\\s*,\\s*${QNAME})*)`,
	"i",
)
// per-process-constant: see above
const DROP_POLICY = /* @__PURE__ */ new RegExp(`^DROP POLICY (?:IF EXISTS )?(${IDENT}) ON (${QNAME})`, "i")
// per-process-constant: a drop of tables, composed once
const DROP_TABLE = /* @__PURE__ */ new RegExp(`^DROP TABLE (?:IF EXISTS )?(${QNAME}(?:\\s*,\\s*${QNAME})*)`, "i")
// per-process-constant: a rename of a table, composed once
const RENAME_TABLE = /* @__PURE__ */ new RegExp(
	`^ALTER TABLE (?:IF EXISTS )?(?:ONLY )?(${QNAME}) RENAME TO (${QNAME})$`,
	"i",
)
const stateKey = (kind: PgObjectKind, key: string) => `${kind} ${key}`

/* comb's guard around a role it creates: the cluster may hold it already */
const ROLE_GUARD =
	/^DO \$comb\$ BEGIN IF NOT EXISTS \(SELECT FROM pg_roles WHERE rolname = '(?:[^']|'')*'\) THEN (CREATE ROLE .*); END IF; END \$comb\$$/is

/** `CREATE ROLE`, run only when the cluster has no role of that name: roles outlive any one database */
const roleIfMissing = (role: PgObject): string =>
	`DO $comb$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${role.key.replaceAll("'", "''")}') THEN ${role.sql}; END IF; END $comb$`

/** The object a CREATE statement defines, if it defines one comb owns; a role read through comb's guard too */
function defined(code: string, sql: string): PgObject | undefined {
	const guarded = ROLE_GUARD.exec(normalizeSql(sql))?.[1]
	if (guarded !== undefined) return defined(codeOf(guarded, "postgres"), guarded)
	const [, materialized, view] = CREATE_VIEW.exec(code) ?? []
	if (view !== undefined)
		return { extras: [], key: lastPart(view), kind: materialized ? "materialized view" : "view", name: view, sql }
	const [, policy, on] = CREATE_POLICY.exec(code) ?? []
	if (policy !== undefined && on !== undefined) {
		return { extras: [], key: `${lastPart(policy)} on ${lastPart(on)}`, kind: "policy", name: policy, on, sql }
	}
	const [, kind, name] = CREATE_NAMED.exec(code) ?? []
	if (kind === undefined || name === undefined) return undefined
	return { extras: [], key: lastPart(name), kind: kind.toLowerCase() as PgObjectKind, name, sql }
}

/** What a drop or a rename of tables, which still reaches Atlas, does to their policies and row level security */
function followTables(code: string, { objects, rls }: PgObjects): void {
	const [, dropped] = DROP_TABLE.exec(code) ?? []
	for (const name of dropped === undefined ? [] : splitTopLevel(dropped)) {
		const table = lastPart(name)
		rls.delete(table)
		for (const [key, object] of objects) {
			if (object.kind === "policy" && lastPart(object.on as string) === table) objects.delete(key)
		}
	}
	const [, from, to] = RENAME_TABLE.exec(code) ?? []
	if (from === undefined || to === undefined) return
	const [old, next] = [lastPart(from), lastPart(to)]
	const secured = rls.get(old)
	rls.delete(old)
	if (secured !== undefined) rls.set(next, { ...secured, name: to })
	const moving = [...objects].filter(([, object]) => object.kind === "policy" && lastPart(object.on as string) === old)
	for (const [key, object] of moving) {
		objects.delete(key)
		const sql = object.sql.replace(CREATE_POLICY, (_, policy: string) => `CREATE POLICY ${policy} ON ${to}`)
		const moved = { ...object, key: `${lastPart(object.name)} on ${next}`, on: to, sql }
		objects.set(stateKey("policy", moved.key), moved)
	}
}

/** A drop of objects comb owns, taken off `objects`: true when the statement is one */
function followDrops(code: string, objects: Map<string, PgObject>): boolean {
	const [, kind, names] = DROP_OBJECTS.exec(code) ?? []
	if (kind !== undefined && names !== undefined) {
		for (const name of splitTopLevel(names))
			objects.delete(stateKey(kind.toLowerCase() as PgObjectKind, lastPart(name)))
		return true
	}
	const [, policy, on] = DROP_POLICY.exec(code) ?? []
	if (policy === undefined || on === undefined) return false
	objects.delete(stateKey("policy", `${lastPart(policy)} on ${lastPart(on)}`))
	return true
}

/** What one statement does to `state`: true when it is about an object comb owns */
function follow(statement: Statement, state: PgObjects, source: string): boolean {
	const { code, sql } = statement
	const { objects } = state
	const made = defined(code, sql)
	if (made !== undefined) {
		/* CREATE OR REPLACE keeps what was said about the object; a drop already removed it */
		const extras = objects.get(stateKey(made.kind, made.key))?.extras ?? []
		objects.set(stateKey(made.kind, made.key), { ...made, extras })
		return true
	}
	if (followRls(statement, state.rls, source)) return true
	const [, sequence, clauses] = ALTER_SEQUENCE.exec(code) ?? []
	const known = sequence === undefined ? undefined : objects.get(stateKey("sequence", lastPart(sequence)))
	if (known !== undefined) {
		objects.set(stateKey("sequence", known.key), { ...known, sql: `CREATE SEQUENCE ${known.name} ${clauses}` })
		return true
	}
	if (followDrops(code, objects) || followExtra(statement, objects, source)) return true
	followTables(code, state)
	return /^REFRESH MATERIALIZED VIEW\b/i.test(code)
}

/**
 * `sql`'s statements split into those Atlas may see and the comb-owned objects, continuing from
 * `state`; `source` names `sql` in a refusal
 */
function separatePgObjects(sql: string, state: PgObjects = emptyPgObjects(), source = "the target schema"): Separated {
	const objects: PgObject[] = []
	const plain: string[] = []
	/* the statements Postgres runs, read over the whole file, its delimiter directive in place (M75) */
	for (const text of pgStatements(sql)) {
		const code = codeOf(text, "postgres")
		const made = defined(code, text)
		if (made !== undefined) objects.push(made)
		if (!follow({ code, sql: text }, state, source)) plain.push(text)
	}
	return { objects, plain, state }
}

const dropOf = (object: PgObject): string =>
	object.kind === "policy"
		? `DROP POLICY IF EXISTS ${object.name} ON ${object.on}`
		: `DROP ${object.kind.toUpperCase()} IF EXISTS ${object.name}`

/** A target statement that adds `object`: an extension only if missing, a changed sequence altered in place */
function addOf(object: PgObject, before: PgObject | undefined): string {
	if (object.kind === "role") return roleIfMissing(object)
	if (object.kind === "extension")
		return object.sql.replace(/^CREATE EXTENSION (?!IF NOT EXISTS )/i, "CREATE EXTENSION IF NOT EXISTS ")
	return before === undefined ? object.sql : object.sql.replace(/^CREATE SEQUENCE/i, "ALTER SEQUENCE")
}

/** Whether `object` of the target needs a statement before Atlas's: new, or a sequence that changed */
function needsAdding(object: PgObject, from: Map<string, PgObject>): boolean {
	const before = from.get(stateKey(object.kind, object.key))
	if (object.kind === "sequence") return !same(object, before)
	return (object.kind === "extension" || object.kind === "role") && before === undefined
}

type Delta = { after: string[]; before: string[] }

/** The statements comb writes around Atlas's: `before` and `after` them */
function pgDelta({ atlasSql, from: state, to }: { atlasSql: string; from: PgObjects; to: Separated }): Delta {
	const from = state.objects
	const tables = atlasTables(atlasSql)
	const dropped = affected(from, to.state.objects, tables.altered)
	const before = [
		...to.objects.filter((o) => needsAdding(o, from)).map((o) => addOf(o, from.get(stateKey(o.kind, o.key)))),
		...[...from].filter(([key, o]) => dropped.has(key) && o.kind === "policy").map(([, o]) => dropOf(o)),
		...[...from]
			.filter(([key, o]) => dropped.has(key) && isView(o))
			.toReversed()
			.map(([, o]) => dropOf(o)),
	]
	const recreate = (o: PgObject) => {
		const key = stateKey(o.kind, o.key)
		return (isView(o) || o.kind === "policy") && (dropped.has(key) || !from.has(key))
	}
	const created = to.objects.filter(recreate)
	const again = new Set([...to.state.objects.keys()].filter((key) => dropped.has(key) || !from.has(key)))
	const sameDefinition = (key: string) => same(from.get(key), to.state.objects.get(key))
	const after = [
		...created.filter(isView).map((o) => o.sql),
		...created.filter((o) => o.kind === "policy").map((o) => o.sql),
		...extrasAfter({ from, to: to.state.objects }, again, sameDefinition),
		...[...from.values()]
			.filter((o) => o.kind === "sequence" && !to.state.objects.has(stateKey(o.kind, o.key)))
			.map(dropOf),
		...rlsDelta(state.rls, to.state.rls, tables),
	]
	return { after, before }
}

/**
 * The DO block that gives the dev database each sequence and extension the given states hold, so
 * a default calling nextval or a column of an extension's type loads there; "" when they hold none
 */
function devPrelude(...states: PgObjects[]): string {
	const made = new Map<string, string>()
	for (const kind of ["extension", "sequence"] as const) {
		for (const { objects } of states) {
			for (const object of objects.values()) {
				if (object.kind !== kind) continue
				const sql = kind === "extension" ? addOf(object, undefined) : `CREATE SEQUENCE IF NOT EXISTS ${object.name}`
				made.set(stateKey(kind, object.key), sql)
			}
		}
	}
	return made.size === 0 ? "" : `DO $comb$ BEGIN ${[...made.values()].join("; ")}; END $comb$;\n`
}

/**
 * `body` under the directive lines of `head`, with exactly one blank line between: Atlas honors a
 * file directive such as `-- atlas:txmode none` only when a blank line follows it, and otherwise
 * runs the file in one transaction without a word
 */
function withDirectivesFirst(head: string, body: string): string {
	const directives = head.replace(/\n+$/, "")
	return directives === "" ? body : `${directives}\n\n${body.replace(/^\n+/, "")}`
}

/** Atlas's migration file with comb's statements around its own, under its leading `atlas:` directives */
function wrapAtlasFile(file: string, { after, before }: Delta): string {
	if (after.length === 0 && before.length === 0) return file
	const head = atlasDirectives(file)
	/* asSql writes nothing for no statements, so an empty side adds no blank line */
	const parts = [asSql(before), file.slice(head.length), asSql(after)]
	return withDirectivesFirst(head, parts.filter((part) => part !== "").join("\n"))
}

export {
	devPrelude,
	emptyPgObjects,
	type PgObject,
	type PgObjects,
	pgDelta,
	separatePgObjects,
	withDirectivesFirst,
	wrapAtlasFile,
}
