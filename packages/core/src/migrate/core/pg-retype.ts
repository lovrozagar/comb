/**
 * A retype's findings, read against the column's type in the history as Postgres 17 decides them
 * (P12 of the 0.15.0 review, PA11 of r22b; tests/integration/postgres/lock-oracle-retype.test.ts
 * holds each rule to the table's and its indexes' filenodes). A retype with no USING keeps every
 * value as it is, so Postgres rewrites nothing, when it changes the type only by a coercion that
 * changes no value:
 * - the same type with the same modifiers, or with none, which coerces no length;
 * - a binary coercion (varchar and text, a varchar or text to bpchar, bit to varbit and back, cidr to
 *   inet, xml to text, int and oid and the reg types) to a type with no modifier;
 * - a modifier the type's length coercion proves keeps every value: a longer varchar or varbit, a
 *   numeric of more precision at the same scale, a timestamp, time or interval of no less precision
 *   (an interval of no fewer fields);
 * - an array of the same element type, with no modifier or the same one, of any dimensions.
 * A domain with a CHECK or NOT NULL up its chain checks every row, so a retype to it rewrites; one
 * with none is its flattened base. A column of a domain is its base with no modifier, as Postgres
 * reads a domain column's values. Every other retype rewrites the table and may change a value (P1
 * of r18). A retype in place still rebuilds every index on the column when its collation changes (a
 * domain's when it names none; P3 of r18), when the type's default btree operator family changes
 * (text to bpchar, bit to varbit, int to oid), or when an array column changes its declared type.
 */
import type { Finding } from "./classify-alter.ts"
import { REWRITES } from "./pg-column-add.ts"
import { domainOf } from "./pg-domains.ts"
import { columnTypeOf, type ColumnType, type Facts, type Node } from "./pg-nodes.ts"

// lookup-table: int, oid and the reg types, each binary-coercible to every other (pg_cast method b)
const OIDS: ReadonlySet<string> = /* @__PURE__ */ new Set([
	"int4",
	"oid",
	"regclass",
	"regcollation",
	"regconfig",
	"regdictionary",
	"regnamespace",
	"regoper",
	"regoperator",
	"regproc",
	"regprocedure",
	"regrole",
	"regtype",
])

// lookup-table: the other binary coercions from each type, by pg_cast's method b
const BINARY: ReadonlyMap<string, readonly string[]> = /* @__PURE__ */ new Map([
	["bit", ["varbit"]],
	["cidr", ["inet"]],
	["text", ["bpchar", "varchar"]],
	["varbit", ["bit"]],
	["varchar", ["bpchar", "text"]],
	["xml", ["bpchar", "text", "varchar"]],
])

// lookup-table: the default btree operator family of each type a binary coercion joins, a reg type's
// oid's; xml has none, so no index is on an xml column
const FAMILY: ReadonlyMap<string, string> = /* @__PURE__ */ new Map([
	["bit", "bit"],
	["bpchar", "bpchar"],
	["cidr", "network"],
	["inet", "network"],
	["int4", "integer"],
	["text", "text"],
	["varbit", "varbit"],
	["varchar", "text"],
])

/** A type's default btree operator family, undefined for one no binary coercion reaches or xml */
const familyOf = (type: string): string | undefined => FAMILY.get(type) ?? (OIDS.has(type) ? "oid" : undefined)

/** A temporal type's or an interval's precision, and an interval's range, when its modifier names none */
const [FULL, FULL_RANGE] = [6, 0x7fff]

/** An interval range's least field, by the field bits Postgres writes it with: second 0 up to year 5 */
const leastField = (range: number): number =>
	[1 << 12, 1 << 11, 1 << 10, 1 << 3, 1 << 1, 1 << 2].findIndex((bit) => (range & bit) !== 0)

type Mods = readonly number[]

/** Whether a modifier's first number is no less than the one it replaces, its length or precision */
const longer = (was: Mods, now: Mods): boolean => (now[0] as number) >= (was[0] ?? Number.NaN)

/** TemporalSimplify: a full precision, or one no less than a bounded one before */
const finer = (was: Mods, now: Mods): boolean => (now[0] as number) >= FULL || longer(was, now)

/** interval_support: no fewer fields, and, where the range ends at second, no less precision */
function wider(was: Mods, now: Mods): boolean {
	const [oldLeast, newLeast] = [leastField(was[0] ?? FULL_RANGE), leastField(now[0] as number)]
	return newLeast <= oldLeast && (oldLeast > 0 || (now[1] ?? FULL) >= (was[1] ?? FULL))
}

/**
 * Each type's length coercion's support function, as PG 17 writes it (varchar_support,
 * varbit_support, numeric_support, TemporalSimplify, interval_support): whether a column of it with
 * modifiers `was` retyped to `now` keeps every value
 */
// lookup-table: the support function of each type whose length coercion has one
const SUPPORT: ReadonlyMap<string, (was: Mods, now: Mods) => boolean> = /* @__PURE__ */ new Map([
	["interval", wider],
	["numeric", (was: Mods, now: Mods) => longer(was, now) && (now[1] ?? 0) === (was[1] ?? 0)],
	["time", finer],
	["timestamp", finer],
	["timestamptz", finer],
	["timetz", finer],
	["varbit", longer],
	["varchar", longer],
])

/** Whether a retype from `from` to `to`, each a type no domain is left in, keeps every value */
function keepsValues(from: ColumnType, to: ColumnType): boolean {
	const same = from.mods.length === to.mods.length && from.mods.every((mod, i) => mod === to.mods[i])
	if (from.dims > 0 || to.dims > 0)
		return from.dims > 0 && to.dims > 0 && from.type === to.type && (to.mods.length === 0 || same)
	if (from.type !== to.type)
		return (
			to.mods.length === 0 &&
			(OIDS.has(from.type) ? OIDS.has(to.type) : BINARY.get(from.type)?.includes(to.type) === true)
		)
	return to.mods.length === 0 || same || SUPPORT.get(from.type)?.(from.mods, to.mods) === true
}

type Domained = { domain: ReturnType<typeof domainOf>; type: ColumnType }

/**
 * Whether a retype in place from `from` to `to` rebuilds the column's indexes, read with the types
 * `source` and `target` they leave once each domain is flattened: a collation changed, a domain's
 * when the column names none; another default operator family; an array column's declared type
 */
function rebuilds({ from, to }: { from: Domained; to: Domained }, source: ColumnType, target: ColumnType): boolean {
	const collation = ({ domain, type }: Domained) => type.collation ?? domain?.over.collation
	if (collation(from) !== collation(to)) return true
	const family = familyOf(source.type)
	if (family !== undefined && family !== familyOf(target.type)) return true
	return (
		(source.dims > 0 || target.dims > 0) && (from.type.type !== to.type.type || from.type.dims > 0 !== to.type.dims > 0)
	)
}

/** What Postgres does retyping a column of `from` to `to` with no USING */
function retype(from: ColumnType, to: ColumnType, facts: Facts): "in place" | "rebuilds" | "rewrites" {
	const [was, now] = [domainOf(from.type, facts), domainOf(to.type, facts)]
	if (from.type === to.type && from.dims > 0 === to.dims > 0) {
		if (!keepsValues(from, to)) return "rewrites"
		return rebuilds({ from: { domain: was, type: from }, to: { domain: now, type: to } }, from, to)
			? "rebuilds"
			: "in place"
	}
	if (to.dims === 0 && now?.constrained === true) return "rewrites"
	/* a domain column's values are its base's, with no modifier; a domain they go to is its base */
	const source = was === undefined || from.dims > 0 ? from : { ...was.over, mods: [] }
	const target = now === undefined || to.dims > 0 ? to : now.over
	if (!keepsValues(source, target)) return "rewrites"
	return rebuilds({ from: { domain: was, type: from }, to: { domain: now, type: to } }, source, target)
		? "rebuilds"
		: "in place"
}

/* the lock warning of a retype in place that rebuilds the column's indexes */
const REBUILDS =
	"rebuilds every index on the column under an ACCESS EXCLUSIVE lock, as its collation, operator family or array type changes"

/** An ALTER COLUMN … TYPE's findings, on the table `key` names in `facts` */
function retypeFindings(cmd: Node, { facts, key }: { facts: Facts; key: string }): Finding[] {
	const def = (cmd["def"] as Node)["ColumnDef"] as Node
	const from = facts.columnTypes.get(key)?.get(String(cmd["name"]))
	const done =
		from === undefined || def["raw_default"] !== undefined
			? "rewrites"
			: retype(from, columnTypeOf(def, facts.schema), facts)
	if (done === "rewrites") return [{ level: "unsafe" }, { level: "lock", note: REWRITES }]
	return done === "rebuilds" ? [{ level: "unsafe" }, { level: "lock", note: REBUILDS }] : []
}

export { retypeFindings }
