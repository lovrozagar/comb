/**
 * A Postgres file as Postgres runs it (M75): the chunks Atlas sends one at a time (atlas-scan.ts),
 * each split into the statements Postgres's parser reads in it, by each RawStmt's `stmt_location`
 * and `stmt_len`, offsets in UTF-8 bytes. A chunk the parser cannot read stays one statement: the
 * classifier rates it unsafe, and a history holding one fails the classification.
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

/** The statements of the Postgres file `sql`, in the order Postgres runs them; throws for a file Atlas cannot split */
const pgStatements = (sql: string): string[] => atlasChunks(sql).flatMap((chunk) => readChunk(chunk).statements)

/** The first statement of `sql` Postgres's parser cannot read, with its reason; undefined when it reads them all */
function pgUnreadable(sql: string): { error: string; statement: string } | undefined {
	for (const chunk of atlasChunks(sql)) {
		const { error, statements } = readChunk(chunk)
		if (error !== undefined) return { error, statement: statements[0] as string }
	}
	return undefined
}

export { pgStatements, pgUnreadable }
