/**
 * Postgres objects Atlas OSS will not diff: views, materialized views, policies, sequences, roles
 * and extensions ("available to logged-in users only"). comb keeps them out of what Atlas sees, as
 * it keeps FTS5 out on SQLite (fts-migration.ts): they are taken out of the history Atlas replays
 * and of the target, and comb writes their part of each migration around Atlas's statements.
 *
 * Before Atlas's statements: new extensions, roles and sequences (a table may use them), changed
 * sequences altered in place (dropping one would restart it), and the drops of every changed or
 * removed policy and view, and of each one over a table Atlas alters (Postgres refuses to retype a
 * column a view or policy reads), dependents first. After them: those views and policies created
 * again from the target, in its order, removed sequences dropped, and each table's row level
 * security brought to the target's (Atlas OSS drops those statements without a word, so a policy
 * would never be enforced). Roles and extensions are only ever added: they outlive any one schema.
 */
import { asSql } from "./fts-migration.ts"
import { atlasTables, followRls, type Rls, rlsDelta, type Statement } from "./pg-tables.ts"
import { codeOf, IDENT, lastPart, QNAME, splitTopLevel } from "./sql-code.ts"
import { normalizeSql, splitSqlStatements } from "./sql-scan.ts"

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

/** The object a CREATE statement defines, if it defines one comb owns */
function defined(code: string, sql: string): PgObject | undefined {
	const [, materialized, view] = CREATE_VIEW.exec(code) ?? []
	if (view !== undefined)
		return { key: lastPart(view), kind: materialized ? "materialized view" : "view", name: view, sql }
	const [, policy, on] = CREATE_POLICY.exec(code) ?? []
	if (policy !== undefined && on !== undefined) {
		return { key: `${lastPart(policy)} on ${lastPart(on)}`, kind: "policy", name: policy, on, sql }
	}
	const [, kind, name] = CREATE_NAMED.exec(code) ?? []
	if (kind === undefined || name === undefined) return undefined
	return { key: lastPart(name), kind: kind.toLowerCase() as PgObjectKind, name, sql }
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

/** What one statement does to `state`: true when it is about an object comb owns */
function follow(statement: Statement, state: PgObjects, source: string): boolean {
	const { code, sql } = statement
	const { objects } = state
	const made = defined(code, sql)
	if (made !== undefined) {
		objects.set(stateKey(made.kind, made.key), made)
		return true
	}
	if (followRls(statement, state.rls, source)) return true
	const [, sequence, clauses] = ALTER_SEQUENCE.exec(code) ?? []
	const known = sequence === undefined ? undefined : objects.get(stateKey("sequence", lastPart(sequence)))
	if (known !== undefined) {
		objects.set(stateKey("sequence", known.key), { ...known, sql: `CREATE SEQUENCE ${known.name} ${clauses}` })
		return true
	}
	const [, kind, names] = DROP_OBJECTS.exec(code) ?? []
	if (kind !== undefined && names !== undefined) {
		for (const name of splitTopLevel(names))
			objects.delete(stateKey(kind.toLowerCase() as PgObjectKind, lastPart(name)))
		return true
	}
	const [, policy, on] = DROP_POLICY.exec(code) ?? []
	if (policy !== undefined && on !== undefined) {
		objects.delete(stateKey("policy", `${lastPart(policy)} on ${lastPart(on)}`))
		return true
	}
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
	for (const statement of splitSqlStatements(sql, "postgres")) {
		const text = statement.trim()
		const code = codeOf(text, "postgres")
		const made = defined(code, text)
		if (made !== undefined) objects.push(made)
		if (!follow({ code, sql: text }, state, source)) plain.push(text)
	}
	return { objects, plain, state }
}

/** Whether a view's definition reads the relation `name` */
function reads(view: PgObject, name: string): boolean {
	const body = codeOf(view.sql, "postgres").split(/ AS /i).slice(1).join(" AS ")
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
	return new RegExp(`(?:^|[^\\w$"])"?${escaped}"?(?=[^\\w$"]|$)`).test(body)
}

const isView = (object: PgObject) => object.kind === "view" || object.kind === "materialized view"
const same = (a: PgObject | undefined, b: PgObject | undefined) =>
	a !== undefined && b !== undefined && normalizeSql(a.sql) === normalizeSql(b.sql)

/** The views and policies of `from` comb must drop: changed, removed, or over what Atlas or comb changes */
function affected(from: Map<string, PgObject>, to: Map<string, PgObject>, tables: ReadonlySet<string>): Set<string> {
	const out = new Set<string>()
	for (const [key, object] of from) {
		if ((isView(object) || object.kind === "policy") && !same(object, to.get(key))) out.add(key)
		if (object.kind === "policy" && tables.has(lastPart(object.on as string))) out.add(key)
		if (isView(object) && [...tables].some((table) => reads(object, table))) out.add(key)
	}
	/* a view over a view comb drops goes too, until no more join */
	let grew = true
	while (grew) {
		grew = false
		for (const [key, object] of from) {
			const over = [...out].some(
				(other) => isView(from.get(other) as PgObject) && reads(object, (from.get(other) as PgObject).key),
			)
			if (isView(object) && !out.has(key) && over) {
				out.add(key)
				grew = true
			}
		}
	}
	return out
}

const dropOf = (object: PgObject): string =>
	object.kind === "policy"
		? `DROP POLICY IF EXISTS ${object.name} ON ${object.on}`
		: `DROP ${object.kind.toUpperCase()} IF EXISTS ${object.name}`

/** A target statement that adds `object`: an extension only if missing, a changed sequence altered in place */
function addOf(object: PgObject, before: PgObject | undefined): string {
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
	const after = [
		...created.filter(isView).map((o) => o.sql),
		...created.filter((o) => o.kind === "policy").map((o) => o.sql),
		...[...from.values()]
			.filter((o) => o.kind === "sequence" && !to.state.objects.has(stateKey(o.kind, o.key)))
			.map(dropOf),
		...rlsDelta(state.rls, to.state.rls, tables),
	]
	return { after, before }
}

/** A migration file's leading `atlas:` directive lines, with the blank lines after them */
const atlasDirectives = (file: string): string => /^(?:--[ \t]*atlas:[^\n]*\n)+\n*/.exec(file)?.[0] ?? ""

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
	atlasDirectives,
	emptyPgObjects,
	type PgObject,
	type PgObjects,
	pgDelta,
	separatePgObjects,
	withDirectivesFirst,
	wrapAtlasFile,
}
