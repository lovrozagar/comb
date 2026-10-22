/**
 * The copy of an Atlas SQLite table rebuild, `INSERT INTO new_T (cols) SELECT … FROM T`, read for
 * whether it keeps every row and value. Atlas writes each target column from the same-named
 * source column, bare or as `IFNULL(col, <the column's new DEFAULT>)` when the column gains NOT
 * NULL, over the whole table. Anything else, a filter, a join, a substituted or renamed value, may
 * lose data, and the reading names what does.
 */
import { IDENT, lastPart, nameKey, QNAME, topLevel } from "./sql-code.ts"
import { affinityOf, definitionAffinity } from "./sqlite-affinity.ts"
import { normalizeSql, segments } from "./sql-scan.ts"

/* Atlas's directive to run a file outside a transaction, where the guard's deferred keys and refill fail */
const TXMODE_NONE: RegExp = /^\s*--\s*atlas:txmode\s+none\b/im
const NO_TRANSACTION: string = "a rebuild needs the file's transaction, which -- atlas:txmode none gives up"

/** A rebuild's copy: the table it fills, the table it reads, its target columns, and what may lose data */
type Copy = { columns: string[]; from: string; into: string; problem: string | undefined }

/**
 * `text` with every string literal's contents and every identifier's blanked to `_`, the same
 * length, so the structure is matched on code while the values are sliced from `text`
 */
const masked = (text: string): string =>
	segments(text)
		.map(({ kind, text: part }) => (kind === "code" ? part : `${part[0]}${"_".repeat(part.length - 2)}${part.at(-1)}`))
		.join("")

/** The ranges of `text` between the commas outside parentheses of its mask */
function topLevelItems(text: string, mask: string): string[] {
	const out: string[] = []
	let depth = 0
	let start = 0
	for (let i = 0; i <= mask.length; i++) {
		const c = mask[i]
		if (c === "(") depth++
		else if (c === ")") depth--
		else if (i === mask.length || (c === "," && depth === 0)) {
			out.push(text.slice(start, i).trim())
			start = i + 1
		}
	}
	return out
}

// per-process-constant: a copy's shape over its mask: target list, SELECT list, source, and what follows
const SHAPE = /* @__PURE__ */ new RegExp(
	`^INSERT INTO (${QNAME}) ?\\(([^)]*)\\) SELECT (.*) FROM (${QNAME})(.*)$`,
	"isd",
)
// per-process-constant: a name alone
const NAME = /* @__PURE__ */ new RegExp(`^${QNAME}$`)
// per-process-constant: an item's top-level alias
const ALIAS = /* @__PURE__ */ new RegExp(` AS (${IDENT})$`, "i")
// per-process-constant: the clause a copy may not have after its FROM
const CLAUSE = /^(?:(?:NATURAL |LEFT |RIGHT |FULL |INNER |CROSS |OUTER )*JOIN|GROUP BY|ORDER BY|\w+)/i

/** Whether `expr` is `column`, by name */
const names = (expr: string, column: string): boolean => NAME.test(expr) && lastPart(expr) === column

/** The DEFAULT each column of a CREATE TABLE declares, as written */
/** Each column of a CREATE TABLE with its definition after the name */
function columnDefinitions(create: string): Map<string, string> {
	const text = normalizeSql(create)
	const mask = masked(text)
	const body = text.slice(mask.indexOf("(") + 1, mask.lastIndexOf(")"))
	const bodyMask = mask.slice(mask.indexOf("(") + 1, mask.lastIndexOf(")"))
	const out = new Map<string, string>()
	let at = 0
	for (const part of topLevelItems(body, bodyMask)) {
		at = body.indexOf(part, at) + part.length
		const name = new RegExp(`^${IDENT}`).exec(part)?.[0]
		if (name !== undefined) out.set(lastPart(name), part.slice(name.length).trim())
	}
	return out
}

function defaults(create: string): Map<string, string> {
	const text = normalizeSql(create)
	const mask = masked(text)
	const open = mask.indexOf("(")
	const out = new Map<string, string>()
	const body = text.slice(open + 1, mask.lastIndexOf(")"))
	const bodyMask = mask.slice(open + 1, mask.lastIndexOf(")"))
	let at = 0
	for (const part of topLevelItems(body, bodyMask)) {
		const start = body.indexOf(part, at)
		at = start + part.length
		const partMask = bodyMask.slice(start, at)
		const name = new RegExp(`^${IDENT}`).exec(part)?.[0]
		const keyword = / DEFAULT /i.exec(topLevel(partMask))
		if (name === undefined || keyword === null) continue
		const rest = part.slice(keyword.index + keyword[0].length)
		const restMask = partMask.slice(keyword.index + keyword[0].length)
		const end = restMask.startsWith("(") ? closing(restMask) + 1 : (/^[^ ]+/.exec(restMask)?.[0].length as number)
		out.set(lastPart(name), rest.slice(0, end))
	}
	return out
}

/** The index of the parenthesis closing the one `mask` opens with */
function closing(mask: string): number {
	let depth = 0
	for (let i = 0; i < mask.length; i++) {
		if (mask[i] === "(") depth++
		else if (mask[i] === ")" && --depth === 0) return i
	}
	return mask.length
}

/**
 * Whether `expr` fills `column` with its own value: bare, IFNULL'd to `fallback`, its new default,
 * or cast to text when the column is text. Any other CAST converts its value (a REAL to an
 * INTEGER drops the fraction, a large integer to REAL loses digits, text to a number becomes 0).
 */
function keeps(
	expr: string,
	mask: string,
	{ column, definition, fallback }: { column: string; definition: string | undefined; fallback: string | undefined },
): boolean {
	if (names(expr, column)) return true
	const cast = /^CAST\((.*) AS ([\w ]+(?:\([\d ,]*\))?)\)$/is.exec(expr)
	if (cast !== null)
		return (
			names((cast[1] as string).trim(), column) &&
			affinityOf(cast[2] as string) === "TEXT" &&
			definitionAffinity(definition ?? "") === "TEXT"
		)
	if (!/^IFNULL\(/i.test(mask) || closing(mask.slice(6)) !== mask.length - 7) return false
	const [value, other, ...more] = topLevelItems(expr.slice(7, -1), mask.slice(7, -1))
	return more.length === 0 && names(value as string, column) && other !== undefined && other === fallback
}

/** What may lose data in a copy's SELECT list, or undefined when every column keeps its value */
function itemProblem(
	text: string,
	mask: string,
	{ columns, create }: { columns: string[]; create: string },
): string | undefined {
	const items = topLevelItems(text, mask)
	if (items.length !== columns.length) return `its copy has ${items.length} values for ${columns.length} columns`
	const fallbacks = defaults(create)
	const definitions = columnDefinitions(create)
	let at = 0
	for (const [i, item] of items.entries()) {
		const start = text.indexOf(item, at)
		at = start + item.length
		const itemMask = mask.slice(start, at)
		const column = columns[i] as string
		const alias = ALIAS.exec(topLevel(itemMask))
		const expr = alias === null ? item : item.slice(0, alias.index)
		const aliasOk = alias === null || lastPart(item.slice(alias.index + 4)) === column
		if (
			!aliasOk ||
			!keeps(expr.trim(), itemMask.slice(0, expr.length).trim(), {
				column,
				definition: definitions.get(column),
				fallback: fallbacks.get(column),
			})
		) {
			return `its copy fills ${column} from ${item}`
		}
	}
	return undefined
}

/** What follows a copy's FROM, its compound, or its subquery, named; undefined when nothing does */
function clauseProblem(mask: string, list: string, rest: string): string | undefined {
	const compound = /\b(UNION|INTERSECT|EXCEPT)\b/i.exec(topLevel(mask))?.[1]
	if (compound !== undefined) return `its copy has ${compound.toUpperCase()}`
	if (/\bSELECT\b/i.test(list)) return "its copy has a subquery"
	if (rest === "") return undefined
	return `its copy has ${rest.startsWith(",") ? "a second table" : (CLAUSE.exec(rest)?.[0].toUpperCase() as string)}`
}

/**
 * The copy `stmt` makes, read against `createOf(table)`, the CREATE TABLE of the table it fills
 * (empty when there is none); undefined when `stmt` is no INSERT … SELECT … FROM a table
 */
function readCopy(stmt: string, createOf: (table: string) => string): Copy | undefined {
	const text = normalizeSql(stmt).replace(/;$/, "")
	const mask = masked(text)
	const shape = SHAPE.exec(mask)
	if (shape === null) return undefined
	const part = (group: number) => {
		const [start, end] = (shape.indices as RegExpIndicesArray)[group] as [number, number]
		return { mask: mask.slice(start, end), text: text.slice(start, end) }
	}
	const [targets, list] = [part(2), part(3)]
	const columns = topLevelItems(targets.text, targets.mask).map(lastPart)
	const into = nameKey(part(1).text, "sqlite")
	const problem =
		clauseProblem(mask, list.mask, part(5).mask.trim()) ??
		itemProblem(list.text, list.mask, { columns, create: createOf(into) })
	return { columns, from: nameKey(part(4).text, "sqlite"), into, problem }
}

/** A SQLite rebuild of `table`: the temporary table it is copied into, and the columns copied */
/** Each rebuilt table: the columns its copy writes, what is wrong with the copy, the copy, and the copy's CREATE TABLE */
type Rebuilds = Map<string, { columns: string[]; definition: string; problem: string | undefined; temp: string }>

// per-process-constant: a CREATE TABLE's table, composed once
const CREATE = /* @__PURE__ */ new RegExp(`^CREATE (?:TEMP |TEMPORARY )?TABLE (?:IF NOT EXISTS )?(${QNAME})`, "i")
// per-process-constant: a rename of one table to another, composed once
const RENAME = /* @__PURE__ */ new RegExp(`^ALTER TABLE (${QNAME}) RENAME TO (${QNAME})$`, "i")
// per-process-constant: the table a write changes, composed once
const WRITES = /* @__PURE__ */ new RegExp(
	`^(?:WITH\\b.*?\\b)?(?:UPDATE (?:OR \\w+ )?|DELETE FROM |(?:INSERT|REPLACE) (?:OR \\w+ )?INTO )(${QNAME})`,
	"i",
)

/**
 * The rebuilds a file makes: a copy into a temporary table renamed to the table it copied. A write
 * to the copy between the copy and the rename changes what lands, whatever the copy kept; the
 * statements of comb's own guard, at `guarded`, are no such write.
 */
function rebuildsOf(
	statements: readonly string[],
	codes: readonly string[],
	guarded: ReadonlySet<number> = new Set(),
): Rebuilds {
	const created = new Map<string, string>()
	const copies = new Map<string, Copy>()
	const rebuilds: Rebuilds = new Map()
	for (const [i, code] of codes.entries()) {
		/* comb's own guard empties and refills a copy it keeps, as written; it changes nothing */
		const written = guarded.has(i) ? undefined : WRITES.exec(code)?.[1]
		const changed = written === undefined ? undefined : copies.get(nameKey(written, "sqlite"))
		if (changed !== undefined) changed.problem = "its copy is changed before the rename"
		const table = CREATE.exec(code)?.[1]
		if (table !== undefined) created.set(nameKey(table, "sqlite"), statements[i] as string)
		const copy = /^INSERT INTO\b/i.test(code)
			? readCopy(statements[i] as string, (into) => created.get(into) ?? "")
			: undefined
		if (copy !== undefined) copies.set(copy.into, copy)
		const done = renamedCopy(code, copies)
		if (done !== undefined) {
			rebuilds.set(done.copy.from, {
				columns: done.copy.columns,
				/* a copy reads only into a table the file created, so its CREATE is known */
				definition: created.get(done.temp) as string,
				problem: done.copy.problem,
				temp: done.temp,
			})
		}
	}
	return rebuilds
}

/** The copy a rename of its temporary table onto the table it read completes, if `code` is one */
function renamedCopy(code: string, copies: ReadonlyMap<string, Copy>): { copy: Copy; temp: string } | undefined {
	const [, temp, to] = RENAME.exec(code) ?? []
	if (temp === undefined || to === undefined) return undefined
	const key = nameKey(temp, "sqlite")
	const copy = copies.get(key)
	return copy !== undefined && copy.from === nameKey(to, "sqlite") ? { copy, temp: key } : undefined
}

export { type Copy, NO_TRANSACTION, readCopy, type Rebuilds, rebuildsOf, TXMODE_NONE }
