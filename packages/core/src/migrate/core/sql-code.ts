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
 * The name a table, trigger or routine is matched by: its last part as `dialect` resolves it.
 * SQLite matches every identifier without regard to ASCII case, quoted or not; Postgres folds an
 * unquoted name to lower case and keeps a quoted one exact.
 */
function nameKey(name: string, dialect: Dialect): string {
	return partKey([...name.matchAll(PARTS)].at(-1)?.[0] ?? name, dialect)
}

/** One name part as `dialect` resolves it (see nameKey) */
function partKey(part: string, dialect: Dialect): string {
	const bare = unquotePart(part)
	return dialect === "sqlite" || bare === part ? bare.toLowerCase() : bare
}

/** A whole name, schema included when written, each part as `dialect` resolves it: `Public."Post"` is `public.Post` */
const qualifiedKey = (name: string, dialect: Dialect): string =>
	[...name.matchAll(PARTS)].map((match) => partKey(match[0], dialect)).join(".")

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

/** A string or dollar-quoted literal's text: `'it''s'` is `it's` */
const literalText = (text: string): string =>
	text.startsWith("'") ? text.slice(1, -1).replaceAll("''", "'") : bodyText(text)

/** The SQL a DO statement runs: its dollar-quoted or single-quoted body */
function doBody(stmt: string): string {
	const body = segments(stmt, "postgres").find(({ kind }) => kind === "body" || kind === "literal")
	return body === undefined ? "" : literalText(body.text)
}

/** The SQL each `EXECUTE '<literal>'` (or `EXECUTE $tag$…$tag$`) of a DO body runs */
function executedSql(body: string): string[] {
	const parts = segments(body, "postgres")
	return parts.flatMap((part, i) => {
		const next = parts[i + 1]
		const literal = part.kind === "code" && /\bEXECUTE\s*$/i.test(part.text) && next?.kind === "literal"
		return literal ? [literalText(next.text)] : []
	})
}

export {
	bodyText,
	codeOf,
	doBody,
	executedSql,
	IDENT,
	lastPart,
	nameKey,
	QNAME,
	qualifiedKey,
	splitTopLevel,
	topLevel,
	unquote,
}
