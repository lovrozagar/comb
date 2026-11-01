/**
 * Statements about an object comb owns on Postgres (pg-objects.ts): a comment, a grant, an
 * `ALTER POLICY`, an `ALTER VIEW … SET`, an index on a materialized view, a trigger on a view, a
 * role granted to another. A statement is about the object it names, whatever its keyword: an
 * `ALTER TABLE` naming a view is read as the `ALTER VIEW` it is (P5 of r18). Atlas replays the history without comb's objects, so it would run such a statement
 * against an object that is not there; comb takes each out of what Atlas sees, keeps it with its
 * object, and writes it again after the object is created again. Any other statement that names
 * an object comb owns is refused, since comb could not keep it.
 */
import { codeOf, IDENT, lastPart, QNAME, splitTopLevel } from "./sql-code.ts"

/** An object comb owns, as far as its statements go: its kind and key, and what was said about it */
type Owned = { extras: string[]; key: string; kind: string; name: string }

/** The objects comb owns, by `${kind} ${key}` */
type Owners = Map<string, Owned>

/** A statement as written and as code */
type Said = { code: string; sql: string }

// per-process-constant: the statements comb keeps with an object, composed once
const COMMENT = /* @__PURE__ */ new RegExp(
	`^COMMENT ON (VIEW|MATERIALIZED VIEW|SEQUENCE|ROLE|EXTENSION) (${QNAME}) IS\\b`,
	"i",
)
// per-process-constant: see above
const COMMENT_POLICY = /* @__PURE__ */ new RegExp(`^COMMENT ON POLICY (${IDENT}) ON (${QNAME}) IS\\b`, "i")
// per-process-constant: see above
const PRIVILEGE = /* @__PURE__ */ new RegExp(
	`^(?:GRANT|REVOKE)\\b.*?\\bON (?:TABLE |SEQUENCE )?(${QNAME}(?: ?, ?${QNAME})*) (?:TO|FROM)\\b`,
	"i",
)
// per-process-constant: see above
const MEMBERSHIP = /* @__PURE__ */ new RegExp(`^(?:GRANT|REVOKE) (${QNAME}(?: ?, ?${QNAME})*) (?:TO|FROM) `, "i")
// per-process-constant: see above
const ALTER_POLICY = /* @__PURE__ */ new RegExp(`^ALTER POLICY (${IDENT}) ON (${QNAME}) (.+)$`, "i")
// per-process-constant: see above
const ALTER_VIEW = /* @__PURE__ */ new RegExp(`^ALTER (VIEW|MATERIALIZED VIEW) (?:IF EXISTS )?(${QNAME}) (.+)$`, "i")
// per-process-constant: see above
const INDEX = /* @__PURE__ */ new RegExp(
	`^CREATE (?:UNIQUE )?INDEX (?:CONCURRENTLY )?(?:IF NOT EXISTS )?(?:(${QNAME}) )?ON (?:ONLY )?(${QNAME})`,
	"i",
)
// per-process-constant: see above
const DROP_INDEX = /* @__PURE__ */ new RegExp(
	`^DROP INDEX (?:CONCURRENTLY )?(?:IF EXISTS )?(${QNAME}(?: ?, ?${QNAME})*)`,
	"i",
)
// per-process-constant: see above
const ALTER_OWNED = /* @__PURE__ */ new RegExp(
	`^ALTER (VIEW|MATERIALIZED VIEW|POLICY|ROLE|EXTENSION) (?:IF EXISTS )?(${QNAME})`,
	"i",
)

// per-process-constant: see above
const TRIGGER_ON = /* @__PURE__ */ new RegExp(
	`^CREATE (?:OR REPLACE )?(?:CONSTRAINT )?TRIGGER (${IDENT}) .*?\\bON (${QNAME}) `,
	"i",
)
// per-process-constant: see above
const DROP_TRIGGER = /* @__PURE__ */ new RegExp(`^DROP TRIGGER (?:IF EXISTS )?(${IDENT}) ON (${QNAME})`, "i")
// per-process-constant: see above
const ALTER_TABLE = /* @__PURE__ */ new RegExp(`^ALTER TABLE (?:IF EXISTS )?(?:ONLY )?(${QNAME}) (.+)$`, "i")

/* what comb keeps of an ALTER VIEW: a setting, an owner, a column's default; a rename or move it cannot keep */
const KEPT_VIEW_ACTION = /^(?:SET|RESET|OWNER TO|ALTER (?:COLUMN )?\S+ (?:SET|DROP) DEFAULT)\b/i

const kindOf = (word: string): string => word.toLowerCase()

/** The view or materialized view comb owns by `name`, as a list of none or one */
const viewNamed = (name: string, owners: Owners): Owned[] =>
	["view", "materialized view"].flatMap((kind) => owners.get(`${kind} ${lastPart(name)}`) ?? [])

/** The owned objects `names` lists, and whether the list names anything else too */
function ownersOf(names: string, owners: Owners, kinds: readonly string[]): { mixed: boolean; owned: Owned[] } {
	const listed = splitTopLevel(names).map(lastPart)
	const owned = listed.flatMap((name) => kinds.flatMap((kind) => owners.get(`${kind} ${name}`) ?? []))
	return { mixed: owned.length > 0 && owned.length < listed.length, owned }
}

/** The object a statement is about, and whether comb keeps it with that object; undefined when it names none */
function about(code: string, owners: Owners): { keep: boolean; owned: Owned[] } | undefined {
	const [, kind, name] = COMMENT.exec(code) ?? []
	if (kind !== undefined)
		return { keep: true, owned: [owners.get(`${kindOf(kind)} ${lastPart(name as string)}`) ?? []].flat() }
	const [, policy, on, rest] = COMMENT_POLICY.exec(code) ?? ALTER_POLICY.exec(code) ?? []
	if (policy !== undefined) {
		const owned = [owners.get(`policy ${lastPart(policy)} on ${lastPart(on as string)}`) ?? []].flat()
		return { keep: !/^RENAME\b/i.test(rest ?? ""), owned }
	}
	return viewAbout(code, owners) ?? grantAbout(code, owners)
}

/** A statement on a view or materialized view: an ALTER VIEW, an ALTER TABLE naming one, a trigger on one, an index */
function viewAbout(code: string, owners: Owners): { keep: boolean; owned: Owned[] } | undefined {
	const [, viewKind, view, action] = ALTER_VIEW.exec(code) ?? []
	if (view !== undefined) {
		const owned = [owners.get(`${kindOf(viewKind as string)} ${lastPart(view)}`) ?? []].flat()
		return { keep: KEPT_VIEW_ACTION.test(action as string), owned }
	}
	const [, table, tableAction] = ALTER_TABLE.exec(code) ?? []
	const altered = table === undefined ? [] : viewNamed(table, owners)
	if (altered.length > 0) return { keep: KEPT_VIEW_ACTION.test(tableAction as string), owned: altered }
	const [, , triggered] = TRIGGER_ON.exec(code) ?? []
	const fired = triggered === undefined ? [] : viewNamed(triggered, owners)
	if (fired.length > 0) return { keep: true, owned: fired }
	const [, , indexed] = INDEX.exec(code) ?? []
	if (indexed === undefined) return undefined
	return { keep: true, owned: [owners.get(`materialized view ${lastPart(indexed)}`) ?? []].flat() }
}

/** A grant or revoke: of a privilege on views, materialized views or sequences, or of roles comb owns */
function grantAbout(code: string, owners: Owners): { keep: boolean; owned: Owned[] } | undefined {
	const [, objects] = PRIVILEGE.exec(code) ?? []
	if (objects !== undefined) {
		const { mixed, owned } = ownersOf(objects, owners, ["view", "materialized view", "sequence"])
		return { keep: !mixed, owned }
	}
	const [, roles] = /\bON\b/i.test(code) ? [] : (MEMBERSHIP.exec(code) ?? [])
	if (roles === undefined) return undefined
	const { mixed, owned } = ownersOf(roles, owners, ["role"])
	return { keep: !mixed, owned }
}

/** An index comb keeps with a materialized view, dropped: taken off it; true when one was */
function dropsKeptIndex(code: string, owners: Owners): boolean {
	const [, names] = DROP_INDEX.exec(code) ?? []
	if (names === undefined) return false
	const dropped = new Set(splitTopLevel(names).map(lastPart))
	let found = false
	for (const owner of owners.values()) {
		const kept = owner.extras.filter((sql) => !dropped.has(lastPart(INDEX.exec(codeOf(sql, "postgres"))?.[1] ?? "")))
		found ||= kept.length < owner.extras.length
		owner.extras = kept
	}
	return found
}

/** A trigger comb keeps with a view, dropped: taken off it; true when it was one */
function dropsKeptTrigger(code: string, owners: Owners): boolean {
	const [, trigger, on] = DROP_TRIGGER.exec(code) ?? []
	if (trigger === undefined || on === undefined) return false
	const owner = viewNamed(on, owners)[0]
	if (owner === undefined) return false
	owner.extras = owner.extras.filter(
		(sql) => lastPart(TRIGGER_ON.exec(codeOf(sql, "postgres"))?.[1] ?? "") !== lastPart(trigger),
	)
	return true
}

/**
 * Keep a statement about an owned object with that object: true when it was kept (so Atlas must
 * not see it), refused when it names an owned object comb cannot keep it with
 */
function followExtra({ code, sql }: Said, owners: Owners, source: string): boolean {
	if (dropsKeptIndex(code, owners) || dropsKeptTrigger(code, owners)) return true
	const found = about(code, owners)
	const named = found !== undefined && found.owned.length > 0
	const other = !named && ALTER_OWNED.exec(code)
	const owner = other ? owners.get(`${kindOf(other[1] as string)} ${lastPart(other[2] as string)}`) : undefined
	if ((named && found.keep === false) || owner !== undefined) {
		throw new Error(
			`${source}: ${sql.trim()} changes an object comb writes itself (a view, policy, sequence, role or extension), which comb cannot keep; drop and create the object again instead`,
		)
	}
	if (!named) return false
	for (const object of found.owned) object.extras.push(sql.trim())
	return true
}

/**
 * What to say again about each target object after its statements: everything kept with it when
 * it is created again (the history's too, when its definition did not change), else only what the
 * history never said
 */
function extrasAfter(
	{ from, to }: { from: Owners; to: Owners },
	recreated: ReadonlySet<string>,
	sameDefinition: (key: string) => boolean,
): string[] {
	const out: string[] = []
	for (const [key, object] of to) {
		const before = from.get(key)?.extras ?? []
		const kept = recreated.has(key) && sameDefinition(key) ? [...before, ...object.extras] : object.extras
		const said = recreated.has(key) || before.length === 0 ? kept : kept.filter((sql) => !before.includes(sql))
		for (const sql of said) if (!out.includes(sql)) out.push(sql)
	}
	return out
}

export { extrasAfter, followExtra, type Owned }
