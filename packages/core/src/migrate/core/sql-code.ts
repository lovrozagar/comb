/**
 * The code of a statement as the destructive-change gate reads it: identifiers kept, strings and
 * comments blanked, a `DO` body read as the code it runs. Names come back unquoted, and a list or
 * an action list splits only at its top-level commas.
 */
import type { Dialect } from "../types.ts"
import { bodyText, joined, segments } from "../../sql-lexer.ts"

/** One name part: double-quoted, backtick or bracket quoted, or bare */
const IDENT: string = `(?:"(?:[^"]|"")*"|\`[^\`]*\`|\\[[^\\]]*\\]|[A-Za-z_\\u0080-\\uffff][\\w$\\u0080-\\uffff]*)`
/** A possibly schema-qualified name */
const QNAME: string = `${IDENT}(?:\\s*\\.\\s*${IDENT})*`
// per-process-constant: a pattern composed from the name grammar, compiled once
const PARTS = /* @__PURE__ */ new RegExp(IDENT, "g")

/** One name part without its quotes, a doubled `""` read as one `"` */
function unquotePart(part: string): string {
	const open = part[0]
	if (open === '"') return part.slice(1, -1).replaceAll('""', '"')
	return open === "`" || open === "[" ? part.slice(1, -1) : part
}

/** A written name, quoted or not, as its parts joined with `.` */
const unquote = (name: string): string => [...name.matchAll(PARTS)].map((match) => unquotePart(match[0])).join(".")

/** The last part of a name: the table of `"public"."post"` is `post` */
const lastPart = (name: string): string => unquote(name).split(".").at(-1) as string

/**
 * How names are keyed: SQLite's way, or Postgres's under the schema comb scopes every URL's
 * search_path to, where an unqualified name resolves (M72)
 */
type Naming = "sqlite" | { schema: string }

/** The naming of `dialect`, a Postgres one under `schema` */
const namingOf = (dialect: Dialect, schema = "public"): Naming => (dialect === "sqlite" ? "sqlite" : { schema })

/** The dialect a naming reads names as */
const dialectOf = (naming: Naming): Dialect => (naming === "sqlite" ? "sqlite" : "postgres")

/**
 * The name a table, trigger or routine is matched by, as `naming` resolves it. SQLite matches
 * every identifier without regard to ASCII case, quoted or not, by its last part. Postgres folds an
 * unquoted name to lower case and keeps a quoted one exact, and resolves an unqualified name in its
 * schema: under `app`, `users` and `app.users` are one table, `public.users` another (M72).
 */
function nameKey(name: string, naming: Naming): string {
	const dialect = dialectOf(naming)
	const parts = [...name.matchAll(PARTS)].map((match) => partKey(match[0], dialect))
	const last = parts.at(-1) ?? partKey(name, dialect)
	const schema = parts.at(-2)
	return naming !== "sqlite" && schema !== undefined && schema !== naming.schema ? `${schema}.${last}` : last
}

/**
 * A name as SQLite folds it, and Postgres an unquoted one in UTF-8: its ASCII letters lowered and no
 * other, so "Über" and "über" are two names and "Users" and "users" one
 */
const asciiFold = (name: string): string => name.replace(/[A-Z]+/g, (letters) => letters.toLowerCase())

/** One name part as `dialect` resolves it (see nameKey) */
function partKey(part: string, dialect: Dialect): string {
	const bare = unquotePart(part)
	return dialect === "sqlite" || bare === part ? asciiFold(bare) : bare
}

/**
 * A pragma statement as SQLite reads it: its name and schema unquoted and folded, the value or argument it gives,
 * and whether its name was written quoted, which sqld's parser refuses (S1 of r22)
 */
type Pragma = { name: string; quoted: boolean; schema: string | undefined; value: string | undefined }

// per-process-constant: a pragma's schema, its name, and the value after its = or in its parentheses, composed once
const PRAGMA_HEAD = /* @__PURE__ */ new RegExp(
	`^PRAGMA (?:(${IDENT}) ?\\. ?)?(${IDENT})(?: ?= ?(.*?)| ?\\( ?(.*?) ?\\))?;?$`,
	"i",
)

/**
 * A pragma's value as SQLite reads it: a single-quoted string is its text (S2 of r20), a quoted name its name, and
 * a number's unary plus is dropped, as SQLite's grammar drops it (`+1` is `1`, `'+1'` stays `+1`)
 */
const pragmaValue = (value: string): string =>
	value.startsWith("'") ? value.slice(1, -1).replaceAll("''", "'") : unquotePart(value.replace(/^\+ ?(?=[\d.])/, ""))

/** The pragma `code` runs (S1 of r19: read once, so a quoted name is the name), or undefined for any other statement */
function pragmaOf(code: string): Pragma | undefined {
	const [, schema, name, set, argument] = PRAGMA_HEAD.exec(code) ?? []
	if (name === undefined) return undefined
	const value = set ?? argument
	return {
		name: partKey(name, "sqlite"),
		quoted: unquotePart(name) !== name,
		schema: schema === undefined ? undefined : partKey(schema, "sqlite"),
		value: value === undefined ? undefined : pragmaValue(value),
	}
}

/** A whole name as SQLite resolves it, each part folded, with the schema it was written with (`main."Post"` is `main.post`) */
const qualifiedKey = (name: string): string =>
	[...name.matchAll(PARTS)].map((match) => partKey(match[0], "sqlite")).join(".")

/**
 * Every name SQLite code can spell, as SQLite resolves one: each bare word and each quoted name unquoted, and each
 * word of a string, which SQLite reads as a name where one stands (`FROM 'post'`) and a module as its option's
 * (`content='post'`), folded by asciiFold; never a word of a comment (8.5 of plan 21)
 */
function sqliteNames(sql: string): Set<string> {
	return new Set([...joined(sql, "sqlite", true).matchAll(PARTS)].map((match) => partKey(match[0], "sqlite")))
}

/* a bare word in Postgres code, which may be a name */
const WORD = /[A-Za-z_\u0080-￿][\w$\u0080-￿]*/g
/* the bytes of a name Postgres keeps (NAMEDATALEN − 1) */
const NAME_BYTES = 63

/** `name` as Postgres stores it: cut at a character to the bytes it keeps */
function stored(name: string): string {
	const chars = [...name]
	while (Buffer.byteLength(chars.join("")) > NAME_BYTES) chars.pop()
	return chars.join("")
}

/**
 * Every name Postgres text can spell (P2 of r22): an unquoted word folded, a quoted one exact, and a
 * string, single or dollar-quoted, as its exact contents and as the SQL it may be, which a DO body,
 * dblink_exec or format() runs; never a comment's words
 */
function namesIn(text: string, into: Set<string> = new Set()): Set<string> {
	for (const { kind, text: part } of segments(text, "postgres")) {
		if (kind === "code") for (const [word] of part.matchAll(WORD)) into.add(stored(asciiFold(word)))
		else if (kind === "identifier") into.add(stored(unquotePart(part)))
		else if (kind !== "comment") {
			const inner = part.startsWith("$") ? bodyText(part) : part.slice(1, -1).replaceAll("''", "'")
			into.add(stored(inner))
			namesIn(inner, into)
		}
	}
	return into
}

/** `code` split at the commas outside parentheses, each part trimmed */
function splitTopLevel(code: string): string[] {
	const parts: string[] = []
	let depth = 0
	let start = 0
	for (let i = 0; i < code.length; i++) {
		if (code[i] === "(") depth++
		else if (code[i] === ")") depth--
		else if (code[i] === "," && depth === 0) {
			parts.push(code.slice(start, i).trim())
			start = i + 1
		}
	}
	return [...parts, code.slice(start).trim()].filter((part) => part !== "")
}

/** `code` with every parenthesized group blanked, so a word left in it is top-level */
function topLevel(code: string): string {
	let out = ""
	let depth = 0
	for (const char of code) {
		if (char === "(") depth++
		out += depth === 0 ? char : " "
		if (char === ")") depth--
	}
	return out
}

export {
	asciiFold,
	dialectOf,
	IDENT,
	lastPart,
	nameKey,
	namesIn,
	type Naming,
	namingOf,
	type Pragma,
	pragmaOf,
	QNAME,
	qualifiedKey,
	splitTopLevel,
	sqliteNames,
	topLevel,
	unquote,
}
