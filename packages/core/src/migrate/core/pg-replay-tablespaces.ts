/**
 * The tablespaces a dev replay leaves out (PR5 of r22b). A tablespace is the server's, so the replay
 * leaves out a history's CREATE TABLESPACE, as it does every statement that reaches past its
 * database, and a statement that then puts a table or an index in that tablespace would fail on
 * devUrl where apply runs it. Where a relation lives changes nothing a later statement reads, so the
 * replay runs such a statement in its database's default tablespace, pg_default, and says so.
 *
 * The statement is rewritten as text, as the parser comb loads writes no SQL back: the name after
 * each TABLESPACE keyword, outside comments, strings, dollar quotes and quoted names, becomes
 * pg_default where it names a tablespace the replay left out. The rewrite runs only when its parse
 * tree is the statement's own with those tablespaces, and nothing else, turned into pg_default; any
 * other statement runs as written, and Postgres refuses it, naming the tablespace.
 */
import { parsePostgres } from "./pg-parser.ts"

type Node = Record<string, unknown>

/** The tablespaces left out, kept up as the replay leaves out `type`'s `node`: CREATE adds, DROP takes, a rename moves */
function leaveOutTablespace(left: Set<string>, type: string, node: Node): void {
	if (type === "CreateTableSpaceStmt") left.add(String(node["tablespacename"]))
	else if (type === "DropTableSpaceStmt") left.delete(String(node["tablespacename"]))
	else if (type === "RenameStmt" && node["renameType"] === "OBJECT_TABLESPACE") {
		/* devUrl's server keeps the old name, so the new one names no tablespace the replay has either */
		left.delete(String(node["subname"]))
		left.add(String(node["newname"]))
	}
}

/** A token of a statement: a word folded to lower case, a quoted name as it stands, or anything else */
type Token = { end: number; kind: "name" | "other"; start: number; value: string }

/* the ends of what holds no token: a line comment, a string (an E string's backslash escapes too), a quoted name */
const LINE = /--[^\n]*/y
const STRING = /'(?:[^']|'')*'/y
const E_STRING = /'(?:[^'\\]|\\.|'')*'/sy
const QUOTED = /"((?:[^"]|"")*)"/y
const WORD = /[A-Za-z_\u0080-￿][\w$\u0080-￿]*/y
const DOLLAR = /\$([A-Za-z_\u0080-￿][\w\u0080-￿]*)?\$/y

/** The end of the match of `pattern` at `at` in `text`, or undefined */
function endOf(pattern: RegExp, text: string, at: number): number | undefined {
	pattern.lastIndex = at
	return pattern.exec(text) === null ? undefined : pattern.lastIndex
}

/** The end of the block comment opening at `at`, which nests */
function commentEnd(text: string, at: number): number {
	let depth = 0
	let i = at
	while (i < text.length) {
		const pair = text.slice(i, i + 2)
		if (pair === "/*") depth++
		else if (pair === "*/") depth--
		i += pair === "/*" || pair === "*/" ? 2 : 1
		if (depth === 0) return i
	}
	return text.length
}

/** The end of what opens at `at` and holds no token, or undefined when a token opens there */
function skipped(text: string, at: number, after: Token | undefined): number | undefined {
	const char = text[at] as string
	if (/\s/.test(char)) return at + 1
	if (text.startsWith("/*", at)) return commentEnd(text, at)
	if (char === "'") {
		/* an E string, the word E right before its quote, escapes with a backslash too */
		const escaped = after?.kind === "name" && after.end === at && after.value === "e"
		return endOf(escaped ? E_STRING : STRING, text, at) ?? text.length
	}
	if (char === "$" && !/[\w$]/.test(text[at - 1] ?? "")) {
		DOLLAR.lastIndex = at
		const open = DOLLAR.exec(text)
		if (open !== null) {
			const close = text.indexOf(open[0], DOLLAR.lastIndex)
			return close < 0 ? text.length : close + open[0].length
		}
	}
	return endOf(LINE, text, at)
}

/** `text`'s tokens, in order */
function tokensOf(text: string): Token[] {
	const tokens: Token[] = []
	let at = 0
	while (at < text.length) {
		const past = skipped(text, at, tokens.at(-1))
		if (past !== undefined) {
			at = past
			continue
		}
		QUOTED.lastIndex = at
		const quoted = QUOTED.exec(text)
		const word = endOf(WORD, text, at)
		const end = quoted === null ? (word ?? at + 1) : QUOTED.lastIndex
		const value = quoted === null ? text.slice(at, end).toLowerCase() : (quoted[1] as string).replaceAll('""', '"')
		tokens.push({ end, kind: quoted !== null || word !== undefined ? "name" : "other", start: at, value })
		at = end
	}
	return tokens
}

// lookup-table: the fields of a parse tree that name a tablespace, each a string
const NAMED: ReadonlySet<string> = /* @__PURE__ */ new Set([
	"indexspace",
	"new_tablespacename",
	"orig_tablespacename",
	"tableSpace",
	"tableSpaceName",
	"tablespacename",
])

/**
 * `tree` without its locations, which a rewrite moves, and with each tablespace of `left` it names
 * as pg_default: by a field that names one, and by ALTER … SET TABLESPACE's name
 */
function inDefaultTree(tree: unknown, left: ReadonlySet<string>): unknown {
	if (Array.isArray(tree)) return tree.map((each) => inDefaultTree(each, left))
	if (typeof tree !== "object" || tree === null) return tree
	const node = tree as Node
	const out: Node = {}
	for (const [key, value] of Object.entries(node)) {
		if (key === "location") continue
		const names = NAMED.has(key) || (key === "name" && node["subtype"] === "AT_SetTableSpace")
		out[key] = names && typeof value === "string" && left.has(value) ? "pg_default" : inDefaultTree(value, left)
	}
	return out
}

/** `tree` as inDefaultTree maps it, REINDEX's TABLESPACE option's name among the names */
function mapped(tree: unknown, left: ReadonlySet<string>): string {
	return JSON.stringify(inDefaultTree(optionNamed(tree, left), left))
}

/** `tree` with REINDEX's TABLESPACE option naming pg_default for a tablespace of `left` */
function optionNamed(tree: unknown, left: ReadonlySet<string>): unknown {
	if (Array.isArray(tree)) return tree.map((each) => optionNamed(each, left))
	if (typeof tree !== "object" || tree === null) return tree
	const node = tree as Node
	const sval = (node["arg"] as { String?: { sval?: unknown } | undefined } | undefined)?.String?.sval
	if (node["defname"] === "tablespace" && typeof sval === "string" && left.has(sval))
		return { ...node, arg: { String: { sval: "pg_default" } } }
	return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, optionNamed(value, left)]))
}

/**
 * `sent`, whose parse tree is `stmt`, with each tablespace of `left` it puts something in turned into
 * pg_default, and the tablespaces it named; undefined when it names none, or when the rewrite's tree
 * is not `stmt`'s so turned, which the replay then runs as written
 */
function inDefault(
	left: ReadonlySet<string>,
	sent: string,
	stmt: unknown,
): { names: string[]; sql: string } | undefined {
	if (left.size === 0) return undefined
	const tokens = tokensOf(sent)
	const names: string[] = []
	let sql = ""
	let at = 0
	tokens.forEach((token, i) => {
		const next = tokens[i + 1]
		if (token.kind !== "name" || token.value !== "tablespace" || next?.kind !== "name" || !left.has(next.value)) return
		sql += `${sent.slice(at, next.start)}pg_default`
		at = next.end
		if (!names.includes(next.value)) names.push(next.value)
	})
	if (names.length === 0) return undefined
	sql += sent.slice(at)
	const rewritten = parsePostgres(sql).stmts as Array<{ stmt: unknown }>
	const same = rewritten.length === 1 && mapped(rewritten[0]?.stmt, new Set()) === mapped(stmt, left)
	return same ? { names, sql } : undefined
}

export { inDefault, leaveOutTablespace, tokensOf }
