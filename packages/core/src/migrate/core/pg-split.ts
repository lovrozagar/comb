/**
 * A Postgres file as Postgres runs it (M75): the chunks Atlas sends one at a time (atlas-scan.ts),
 * each split into the statements Postgres's parser reads in it, by each RawStmt's `stmt_location`
 * and `stmt_len`, offsets in UTF-8 bytes. A chunk the parser cannot read stays one statement: the
 * classifier rates it unsafe, and a history holding one fails the classification. Each file is
 * parsed once: its read keeps every statement's parse tree, and extractSchema records it beside
 * the schema it leaves (recordRead), which the history's facts and the file-naming check read. A
 * file comb writes from such statements (atlasFile) is one Atlas sends each of alone.
 */
import { atlasChunks, type Chunk, unterminated } from "./atlas-scan.ts"
import { parsePostgres, postgresParser } from "./pg-parser.ts"

type RawStmt = { stmt_len?: number; stmt_location?: number }

/** A statement Postgres runs, with its parse tree (the parser's one RawStmt), none when the parser cannot read it */
type PgStatement = { text: string; tree: RawStmt[] | undefined }

/** A statement the parser cannot read, with its reason */
type Unreadable = { error: string; statement: string }

/** A chunk's statements, or the chunk whole with the parser's reason when it cannot read it */
type Read = { error?: string; statements: PgStatement[] }

/** A Postgres file read: its statements in order, and the first the parser cannot read */
type PgRead = { statements: PgStatement[]; unreadable: Unreadable | undefined }

/** The statements Postgres reads in one chunk, the comments before it kept on the first */
function readChunk(chunk: Chunk): Read {
	/* the parser is loaded, or this throws before a chunk is read as unreadable */
	postgresParser()
	const source = chunk.lead === "" ? chunk.text : `${chunk.lead}\n${chunk.text}`
	/* an empty chunk, as two delimiters in a row send, is no statement; the parser refuses it */
	if (source === "") return { statements: [] }
	let stmts: RawStmt[]
	try {
		stmts = parsePostgres(source).stmts as RawStmt[]
	} catch (error) {
		return { error: (error as Error).message, statements: [{ text: unterminated(chunk), tree: undefined }] }
	}
	const bytes = new TextEncoder().encode(source)
	const decoder = new TextDecoder()
	const statements = stmts.map((stmt) => {
		const { stmt_len: length = 0, stmt_location: from = 0 } = stmt
		const text = decoder.decode(bytes.subarray(from, length === 0 ? bytes.length : from + length)).trim()
		return { text, tree: [stmt] }
	})
	return { statements: statements.filter(({ text }) => text !== "") }
}

/** A migration file's leading `atlas:` directive lines, with the blank lines after them */
const atlasDirectives = (file: string): string => /^(?:--[ \t]*atlas:[^\n]*\n)+\n*/.exec(file)?.[0] ?? ""

/** The chunks of `sql`, the file's directives, which are no statement's comments, off the first one's lead */
function chunksOf(sql: string): Chunk[] {
	const chunks = atlasChunks(sql)
	const [first] = chunks
	if (first !== undefined) first.lead = first.lead.replace(/^(?:--[ \t]*atlas:[^\n]*(?:\n|$))+/, "").trim()
	return chunks
}

/** The Postgres file `sql` read once: its statements in the order Postgres runs them, with their trees; throws for a file Atlas cannot split */
function pgRead(sql: string): PgRead {
	const read: PgRead = { statements: [], unreadable: undefined }
	for (const chunk of chunksOf(sql)) {
		const { error, statements } = readChunk(chunk)
		if (error !== undefined) read.unreadable ??= { error, statement: (statements[0] as PgStatement).text }
		read.statements.push(...statements)
	}
	return read
}

/** The statements of the Postgres file `sql`, in the order Postgres runs them; throws for a file Atlas cannot split */
const pgStatements = (sql: string): string[] => pgRead(sql).statements.map(({ text }) => text)

/** What extractSchema read for a schema: the history's trees (none when one before it was never read), and its file's first unreadable statement */
type Recorded = { trees: Array<RawStmt[] | undefined> | undefined; unreadable: Unreadable | undefined }

// lru-cache: each Postgres schema's read, released with the schema; one without a record (a copy, or one built elsewhere) is parsed again
const READS = /* @__PURE__ */ new WeakMap<object, Recorded>()

/** Record `read`, the file that took `from` to `schema`, beside `schema` */
function recordRead(schema: object, from: { statements: readonly string[] }, read: PgRead): void {
	const before = from.statements.length === 0 ? [] : READS.get(from)?.trees
	const trees = before === undefined ? undefined : [...before, ...read.statements.map(({ tree }) => tree)]
	READS.set(schema, { trees, unreadable: read.unreadable })
}

/** The parse tree of each of `schema`'s history statements, none for one the parser cannot read; undefined without a record */
const historyTrees = (schema: object): ReadonlyArray<RawStmt[] | undefined> | undefined => READS.get(schema)?.trees

/** The first statement of the file that left `schema` the parser cannot read, with its reason */
const fileUnreadable = (schema: object): Unreadable | undefined => READS.get(schema)?.unreadable

/** A first-line delimiter directive, which Atlas honors only there */
const DELIMITER_DIRECTIVE = /^-- atlas:delimiter(?=[ \n])[^\n]*\n/

/** Whether Atlas sends each statement of `file` alone, as the one statement Postgres reads in it, in order */
function sendsAlone(file: string, statements: readonly string[]): boolean {
	let chunks: Chunk[]
	try {
		chunks = chunksOf(file)
	} catch {
		// reason: a file Atlas cannot split sends nothing alone
		return false
	}
	return (
		chunks.length === statements.length &&
		chunks.every((chunk, i) => {
			const read = readChunk(chunk)
			return read.error === undefined && read.statements.length === 1 && read.statements[0]?.text === statements[i]
		})
	)
}

/** A delimiter no statement holds, which ends a chunk only where comb puts it */
function freeDelimiter(statements: readonly string[]): string {
	let n = 0
	while (statements.some((statement) => statement.includes(`@comb${n}@`))) n++
	return `@comb${n}@`
}

/**
 * The migration file of `statements` under `head`, its directives kept as they are (Atlas honors
 * one only when a blank line follows), a delimiter directive dropped: one Atlas sends each
 * statement of alone, each ended by `;` where Atlas reads it so, else every one by a delimiter of
 * the file's own, which its first line sets
 */
function atlasFile(statements: readonly string[], head = ""): string {
	const rest = head.replace(DELIMITER_DIRECTIVE, "").replace(/^\n+$/, "")
	const plain = `${rest}${statements.map((statement) => `${statement};\n`).join("")}`
	if (sendsAlone(plain, statements)) return plain
	const delim = freeDelimiter(statements)
	const body = statements.map((statement) => `${statement}\n${delim}\n`).join("")
	const own = `-- atlas:delimiter ${delim}\n${rest === "" ? "\n" : rest}${body}`
	if (sendsAlone(own, statements)) return own
	throw new Error(`comb cannot write these statements so that Atlas sends each alone: ${JSON.stringify(statements)}`)
}

export {
	atlasDirectives,
	atlasFile,
	fileUnreadable,
	historyTrees,
	type PgRead,
	pgRead,
	type PgStatement,
	pgStatements,
	recordRead,
}
