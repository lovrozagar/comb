/**
 * Atlas's statement scanner as atlas 1.3.0 runs it on a Postgres directory: sql/migrate/lex.go's
 * Scanner with sql/postgres's ScanStmts options (BEGIN … END and BEGIN ATOMIC … END blocks,
 * dollar quotes). It yields the chunks Atlas sends Postgres one at a time, each of which Postgres
 * may run as several statements (M75). A file whose first line is `-- atlas:delimiter X` ends its
 * chunks at X instead of `;`, as a `DELIMITER X` line opening a chunk does from there on.
 *
 * Ported case for case, Atlas's quirks kept, since they decide what runs:
 * - No backslash escapes: Atlas tests the quote itself for E'…''s E, so `\'` never escapes.
 * - A custom delimiter ends a chunk even inside a word, a comment, or a string-free paren-free run.
 * - A delimiter that opens with `$` ends a chunk inside a dollar quote, being tested first.
 * - Block comments do not nest, and a backtick quotes as `"` does.
 */

/** A file Atlas refuses to split: Atlas's reason, at Atlas's line and byte column */
class AtlasScanError extends Error {}

type Scan = {
	/** where in `src` the scanned input starts, past a delimiter directive */
	base: number
	/** the delimiter that ends a chunk */
	delim: string
	/** the text not yet emitted, read from `pos` */
	input: string
	pos: number
	/** the text this scan was given, for an error's line and column */
	src: string
	/** where, in `total`'s terms, the chunk being read starts, its leading comments with it */
	start: number
	/** how far past `base` the scan has read, as a nested block's caller skips it */
	total: number
	/** the width of the last character read */
	width: number
}

/** A chunk Atlas sends, exactly as it sends it, and the comments before it that it leaves out */
type Chunk = { lead: string; text: string }

/** The paren depth of the chunk being read, and where its first open paren was */
type Parens = { depth: number; opening: number }

const DELIMITER = ";"
const COMMAND = "delimiter"
/** End of input, as `next` reads it */
const EOS = ""
/* RE2's \s is [\t\n\f\r ]; Go's unicode.IsSpace adds \v, NEL and the Unicode spaces, never U+FEFF */
const GO_SPACE = /[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/
const DOLLAR_QUOTE = /\$(?:[A-Za-z\u00c8-\u00ff_][\w\u00c8-\u00ff]*)*\$/y
const BEGIN_ATOMIC = /[\t\n\f\r ]*BEGIN[\t\n\f\r ]+ATOMIC[\t\n\f\r ]+/iy
const BEGIN = /[\t\n\f\r ]*BEGIN[\t\n\f\r ]+/iy
const END = /^[\t\n\f\r ]*END[\t\n\f\r ]*/i
/* Go's . is [^\n]; the directive sits on the input's first line only */
const DIRECTIVE = /^([ -~]*)atlas:(\w+)(?: +([^\n]+))*/

/** The match of the sticky `pattern` at `at` in `text`, or "" */
function stickyAt(pattern: RegExp, text: string, at: number): string {
	pattern.lastIndex = at
	return pattern.exec(text)?.[0] ?? ""
}

/** `text` without the Go spaces it opens with */
function trimStart(text: string): string {
	let at = 0
	while (at < text.length && GO_SPACE.test(text[at] as string)) at++
	return text.slice(at)
}

/** `text` without the Go spaces around it */
function trim(text: string): string {
	let end = text.length
	while (end > 0 && GO_SPACE.test(text[end - 1] as string)) end--
	return trimStart(text.slice(0, end))
}

const bytes = (text: string) => new TextEncoder().encode(text).length

/** A refusal at `pos` of the unread input, as Atlas words it: `line:column: reason`, the column in bytes */
function failure(s: Scan, pos: number, reason: string): AtlasScanError {
	const before = s.src.slice(0, s.src.length - s.input.length + pos)
	const line = before.split("\n").length
	const column = line === 1 ? bytes(before) : bytes(before.slice(before.lastIndexOf("\n") + 1))
	return new AtlasScanError(`${line}:${column}: ${reason}`)
}

function addPos(s: Scan, by: number): void {
	s.pos += by
	s.total += by
}

/** The next character, EOS at the end */
function next(s: Scan): string {
	if (s.pos >= s.input.length) return EOS
	const char = String.fromCodePoint(s.input.codePointAt(s.pos) as number)
	s.width = char.length
	addPos(s, char.length)
	return char
}

/** The next character, left unread */
function pick(s: Scan): string {
	const { pos, total, width } = s
	const char = next(s)
	Object.assign(s, { pos, total, width })
	return char
}

function skipSpaces(s: Scan): void {
	const before = s.input.length
	s.input = trimStart(s.input)
	s.total += before - s.input.length
}

/** Set the delimiter, `\n`, `\r` and `\t` unescaped */
function setDelim(s: Scan, delim: string): void {
	if (delim === "") throw new AtlasScanError("empty delimiter")
	const escapes: Readonly<Record<string, string>> = { "\\n": "\n", "\\r": "\r", "\\t": "\t" }
	s.delim = delim.replace(/\\[nrt]/g, (escape) => escapes[escape] as string)
}

/** A scan of `input`, its delimiter set by a first-line `-- atlas:delimiter` directive */
function scanOf(input: string): Scan {
	const s: Scan = { base: 0, delim: DELIMITER, input, pos: 0, src: input, start: 0, total: 0, width: 0 }
	const directive = DIRECTIVE.exec(input)
	if (directive?.[2] !== "delimiter" || directive[1] !== "-- ") return s
	const delim = directive[3] ?? ""
	setDelim(s, delim)
	const newline = input.indexOf("\n")
	if (newline === -1) throw failure(s, s.pos, `no input found after delimiter ${JSON.stringify(delim)}`)
	s.input = input.slice(newline + 1)
	s.base = newline + 1
	return s
}

/** The chunk read so far, emitted: the input moves past it, the delimiter trimmed when not `;` */
function emit(s: Scan, text: string): Chunk {
	const lead = trim(s.src.slice(s.base + s.start, s.base + s.total - s.pos))
	s.input = s.input.slice(s.pos)
	s.pos = 0
	s.start = s.total
	const kept = s.delim !== DELIMITER && text.endsWith(s.delim) ? text.slice(0, -s.delim.length) : text
	return { lead, text: trim(kept) }
}

/** Past the quoted text opening before `pos`; an unclosed one refuses the file */
function skipQuote(s: Scan, quote: string): void {
	const at = s.pos
	for (;;) {
		const char = next(s)
		if (char === EOS) throw failure(s, at, `unclosed quote '${quote === "'" ? "\\'" : quote}'`)
		if (char === quote) return
	}
}

/** Past the dollar-quoted text opening before `pos`, to its closing tag or the end */
function skipDollarQuote(s: Scan): void {
	const tag = stickyAt(DOLLAR_QUOTE, s.input, s.pos - 1)
	addPos(s, tag.length - 1)
	const close = s.input.indexOf(tag, s.pos)
	addPos(s, close === -1 ? s.input.length - s.pos : close + tag.length - s.pos)
}

/** Past a comment opening before `pos`; one that opens the chunk is not part of it */
function comment(s: Scan, [left, right]: readonly [string, string]): void {
	const close = s.input.indexOf(right, s.pos)
	if (close === -1) return
	const atStart = s.pos === left.length
	addPos(s, close - s.pos + right.length)
	if (!atStart) return
	s.input = s.input.slice(s.pos)
	s.pos = 0
	skipSpaces(s)
}

/** A `DELIMITER X` line opening the chunk: X is the delimiter from here, and the line is no chunk */
function delimiterCommand(s: Scan): void {
	if (pick(s) !== " ") return
	for (let char = pick(s); char !== EOS && char !== "\n"; char = next(s)) {
		/* read to the end of the line */
	}
	let delim = trim(s.input.slice(COMMAND.length, s.pos))
	if (delim.startsWith("'") && delim.endsWith("'")) delim = delim.slice(1, -1).replaceAll("''", "'")
	setDelim(s, delim)
	emit(s, s.input.slice(0, s.pos))
}

/**
 * Past the statements of a block opening at `pos`, `opener` matched there, through the first one
 * `closes`: whether it closed. One that does not leaves `pos` past the opener, as Atlas does.
 */
function skipBlock(s: Scan, opener: RegExp, closes: (text: string) => boolean): boolean {
	const opened = stickyAt(opener, s.input, s.pos - 1)
	if (opened === "") return false
	addPos(s, opened.length - 1)
	try {
		const body = scanOf(s.input.slice(s.pos))
		let read = chunk(body)
		while (read !== null && !closes(read.text)) read = chunk(body)
		if (read === null) return false
		addPos(s, body.total)
		return true
	} catch {
		// reason: every throw in this module is an AtlasScanError, which here means no block, as in Atlas
		return false
	}
}

/** Whether a block's statement is its END, as Atlas's BEGIN … END matching takes one */
function endsBlock(text: string, delim: string): boolean {
	const end = END.exec(text)?.[0]
	return end !== undefined && (end.length === text.length || text.slice(end.length) === delim)
}

/** The character `char` read in code, outside any quote: the chunk's text when it ends it */
function readCode(s: Scan, char: string): string | undefined {
	if (char === "$" && stickyAt(DOLLAR_QUOTE, s.input, s.pos - 1) !== "") skipDollarQuote(s)
	else if (char === "-" && pick(s) === "-") {
		next(s)
		comment(s, ["--", "\n"])
	} else if (char === "/" && pick(s) === "*") {
		next(s)
		comment(s, ["/*", "*/"])
	} else if (s.delim !== DELIMITER) return undefined
	else if (stickyAt(BEGIN_ATOMIC, s.input, s.pos - 1) !== "") {
		if (skipBlock(s, BEGIN_ATOMIC, (text) => END.test(text))) return s.input.slice(0, s.pos)
	} else if (opensBegin(s) && skipBlock(s, BEGIN, (text) => endsBlock(text, s.delim))) return s.input.slice(0, s.pos)
	return undefined
}

/** Whether a BEGIN block may open here: the chunk opens with BEGIN, or one follows a space */
const opensBegin = (s: Scan) =>
	(s.pos === 1 && stickyAt(BEGIN, s.input, 0) !== "") || (s.pos > 1 && stickyAt(BEGIN, s.input, s.pos - 2) !== "")

/** Whether a `DELIMITER` line opens the chunk here, any case */
const opensCommand = (s: Scan) =>
	s.pos === 1 && s.input.length > COMMAND.length && s.input.slice(0, COMMAND.length).toLowerCase() === COMMAND

/** One character of the chunk: its text when it ends the chunk, null at the end of the input */
function step(s: Scan, char: string, parens: Parens): string | null | undefined {
	if (char === EOS) {
		if (parens.depth > 0) throw failure(s, parens.opening, "unclosed '('")
		return s.pos > 0 ? s.input : null
	}
	if (char === "(") {
		if (parens.depth === 0) parens.opening = s.pos
		parens.depth++
	} else if (char === ")") {
		if (parens.depth === 0) throw failure(s, s.pos, "unexpected ')'")
		parens.depth--
	} else if (char === "'" || char === '"' || char === "`") skipQuote(s, char)
	else if (opensCommand(s)) {
		addPos(s, COMMAND.length - 1)
		delimiterCommand(s)
		skipSpaces(s)
	} else if (parens.depth === 0 && s.input.startsWith(s.delim, s.pos - s.width)) {
		addPos(s, s.delim.length - s.width)
		return s.input.slice(0, s.pos)
	} else return readCode(s, char)
	return undefined
}

/** The next chunk of `s`, trimmed; null past the last, as Atlas's io.EOF */
function chunk(s: Scan): Chunk | null {
	const parens: Parens = { depth: 0, opening: 0 }
	skipSpaces(s)
	for (;;) {
		const text = step(s, next(s), parens)
		if (text === null) return null
		if (text !== undefined) return emit(s, text)
	}
}

/**
 * The chunks Atlas 1.3.0 sends Postgres for the file `sql`, in order: each text trimmed and without
 * a custom delimiter (a `;` stays), beside the comments before it, which Atlas leaves out. Throws,
 * with Atlas's reason, for a file Atlas refuses to split.
 */
function atlasChunks(sql: string): Chunk[] {
	try {
		const s = scanOf(sql)
		const chunks: Chunk[] = []
		for (let text = chunk(s); text !== null; text = chunk(s)) chunks.push(text)
		return chunks
	} catch (error) {
		throw new Error(`Atlas cannot split this file: ${(error as Error).message}`, { cause: error })
	}
}

/** A chunk's text after its leading comments, without the `;` Atlas leaves on it */
function unterminated({ lead, text }: Chunk): string {
	const statement = text.endsWith(";") ? text.slice(0, -1).trimEnd() : text
	return lead === "" || statement === "" ? statement : `${lead}\n${statement}`
}

export { atlasChunks, type Chunk, unterminated }
