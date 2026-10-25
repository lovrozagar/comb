/**
 * The code of a statement as the destructive-change gate reads it: identifiers kept, strings and
 * comments blanked, a `DO` body read as the code it runs. Names come back unquoted, and a list or
 * an action list splits only at its top-level commas.
 */
import type { Dialect } from "../types.ts"
import { segments } from "./sql-scan.ts"

/** One name part: double-quoted, backtick or bracket quoted, or bare */
const IDENT: string = `(?:"(?:[^"]|"")*"|\`[^\`]*\`|\\[[^\\]]*\\]|[A-Za-z_\\u0080-\\uffff][\\w$\\u0080-\\uffff]*)`
/** A possibly schema-qualified name */
const QNAME: string = `${IDENT}(?:\\s*\\.\\s*${IDENT})*`
// per-process-constant: a pattern composed from the name grammar, compiled once
const PARTS = /* @__PURE__ */ new RegExp(IDENT, "g")
const DOLLAR_TAG = /^\$[^$]*\$/

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
 * A whole name as `naming` resolves it, each part folded: on SQLite with the schema it was written
 * with (`main."Post"` is `main.post`), on Postgres as nameKey keys it (`public."Post"` is `Post`
 * under public)
 */
const qualifiedKey = (name: string, naming: Naming): string =>
	naming === "sqlite"
		? [...name.matchAll(PARTS)].map((match) => partKey(match[0], "sqlite")).join(".")
		: nameKey(name, naming)

/** A dollar-quoted body without its tags */
function bodyText(text: string): string {
	const tag = DOLLAR_TAG.exec(text)?.[0] as string
	return text.endsWith(tag) && text.length >= 2 * tag.length
		? text.slice(tag.length, -tag.length)
		: text.slice(tag.length)
}

/**
 * A statement's code: identifiers kept, a DO body read as code itself, strings and comments one
 * space, whitespace collapsed
 */
function codeOf(stmt: string, dialect: Dialect): string {
	return segments(stmt, dialect)
		.map(({ kind, text }) => {
			if (kind === "code" || kind === "identifier") return text
			return kind === "body" ? ` ${codeOf(bodyText(text), dialect)} ` : " "
		})
		.join("")
		.replace(/\s+/g, " ")
		.trim()
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
	bodyText,
	codeOf,
	dialectOf,
	IDENT,
	lastPart,
	nameKey,
	type Naming,
	namingOf,
	QNAME,
	qualifiedKey,
	splitTopLevel,
	topLevel,
	unquote,
}
