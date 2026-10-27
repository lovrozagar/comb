/**
 * A Postgres file as Postgres runs it (M75): the chunks Atlas sends one at a time (atlas-scan.ts),
 * each split into the statements Postgres's parser reads in it, by each RawStmt's `stmt_location`
 * and `stmt_len`, offsets in UTF-8 bytes. A chunk the parser cannot read stays one statement: the
 * classifier rates it unsafe, and a history holding one fails the classification. A file comb
 * writes from such statements (atlasFile) is one Atlas sends each of alone.
 */
import { atlasChunks, type Chunk, unterminated } from "./atlas-scan.ts"
import { postgresParser } from "./pg-parser.ts"

type RawStmt = { stmt_len?: number; stmt_location?: number }

/** A chunk's statements, or the chunk whole with the parser's reason when it cannot read it */
type Read = { error?: string; statements: string[] }

/** The statements Postgres reads in one chunk, the comments before it kept on the first */
function readChunk(chunk: Chunk): Read {
	const parser = postgresParser()
	const source = chunk.lead === "" ? chunk.text : `${chunk.lead}\n${chunk.text}`
	/* an empty chunk, as two delimiters in a row send, is no statement; the parser refuses it */
	if (source === "") return { statements: [] }
	let stmts: RawStmt[]
	try {
		stmts = parser.parseSync(source).stmts as RawStmt[]
	} catch (error) {
		return { error: (error as Error).message, statements: [unterminated(chunk)] }
	}
	const bytes = new TextEncoder().encode(source)
	const decoder = new TextDecoder()
	const statements = stmts.map(({ stmt_len: length = 0, stmt_location: from = 0 }) =>
		decoder.decode(bytes.subarray(from, length === 0 ? bytes.length : from + length)).trim(),
	)
	return { statements: statements.filter((statement) => statement !== "") }
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

/** The statements of the Postgres file `sql`, in the order Postgres runs them; throws for a file Atlas cannot split */
const pgStatements = (sql: string): string[] => chunksOf(sql).flatMap((chunk) => readChunk(chunk).statements)

/** The first statement of `sql` Postgres's parser cannot read, with its reason; undefined when it reads them all */
function pgUnreadable(sql: string): { error: string; statement: string } | undefined {
	for (const chunk of chunksOf(sql)) {
		const { error, statements } = readChunk(chunk)
		if (error !== undefined) return { error, statement: statements[0] as string }
	}
	return undefined
}

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
			return read.error === undefined && read.statements.length === 1 && read.statements[0] === statements[i]
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

export { atlasDirectives, atlasFile, pgStatements, pgUnreadable }
