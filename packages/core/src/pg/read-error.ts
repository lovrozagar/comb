/**
 * A Postgres server error as the three drivers hand it over, read into one shape: node-postgres,
 * postgres.js and Bun.SQL name its fields differently, and a wrapper such as drizzle's may carry
 * the SQL it ran. error-handler.ts maps what this reads to a CombError.
 */

type PgErrorRead = {
	code: string
	column: string | undefined
	constraint: string | undefined
	/** the columns in `detail`'s `Key (a, b)=(…)`, its expressions left out */
	keyColumns: string[]
	/** the key holds an expression, an expression index's, which may spell any column (Q3 of the 0.14.1 review) */
	keyExpression: boolean
	/** the server's message: read only for P0001, which an app's own RAISE EXCEPTION wrote */
	message: string | undefined
	/** the SQL a wrapper such as drizzle's recorded, when one did */
	query?: string | undefined
	/** a foreign key violation of a row others still reference (a delete or a key update), not of a missing parent */
	referenced: boolean
	/** the violated table's schema, which a pgSchema's table is keyed by in the maps (F51) */
	schema: string | undefined
	table: string | undefined
}

const SQLSTATE = /^[0-9A-Z]{5}$/

const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined)

/** The fields the three drivers put on a server error, under either name. */
type DriverError = {
	cause?: unknown
	code?: unknown
	column?: unknown
	column_name?: unknown
	constraint?: unknown
	constraint_name?: unknown
	detail?: unknown
	errno?: unknown
	message?: unknown
	query?: unknown
	schema?: unknown
	schema_name?: unknown
	table?: unknown
	table_name?: unknown
}

function fields(error: object): DriverError {
	return error as DriverError
}

/** The SQLSTATE of one error: node-postgres and postgres.js put it on `code`, Bun.SQL on `errno`. */
function sqlstate(error: DriverError): string | undefined {
	for (const value of [error.code, error.errno]) if (typeof value === "string" && SQLSTATE.test(value)) return value
	return undefined
}

/* one name in a Key list: an identifier Postgres quoted, its doubled quotes standing for one, or
   bare text up to a top-level comma, an expression's parentheses included (U44) */
// per-process-constant: see above
const KEY_NAME = /\s*(?:"((?:[^"]|"")*)"|((?:[^,()]|\((?:[^()]|\([^()]*\))*\))+))\s*(,|\)=)/y

/* a name Postgres writes unquoted (quote_identifier): an ASCII lower-case letter or `_`, then those or digits, no keyword; it quotes any other */
// per-process-constant: see above
const BARE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/

/**
 * The columns in `detail`'s `Key (a, "b, c")=(…)`, each read as the identifier Postgres wrote, and
 * whether it holds an expression, such as `lower(email::text)`: unquoted text no identifier spells
 */
function keyOf(detail: string | undefined): Pick<PgErrorRead, "keyColumns" | "keyExpression"> {
	const line = detail ?? ""
	const none = { keyColumns: [], keyExpression: false }
	if (!line.startsWith("Key (")) return none
	const key = { keyColumns: [] as string[], keyExpression: false }
	KEY_NAME.lastIndex = "Key (".length
	for (let at = KEY_NAME.exec(line); at !== null; at = KEY_NAME.exec(line)) {
		const [, quoted, bare, end] = at
		const name = quoted === undefined ? (bare as string).trim() : quoted.replaceAll('""', '"')
		if (quoted === undefined && !BARE_IDENTIFIER.test(name)) key.keyExpression = true
		else key.keyColumns.push(name)
		if (end === ")=") return key
	}
	return none
}

/**
 * The Postgres server error inside `error`, or null when there is none. The chain is read innermost
 * first: the driver's error is the deepest, and a wrapper's own `code` never wins over it.
 */
function readPgError(error: unknown): PgErrorRead | null {
	const chain: DriverError[] = []
	for (let current: unknown = error; chain.length < 8 && typeof current === "object" && current !== null;) {
		const f = fields(current)
		chain.push(f)
		current = f.cause
	}
	for (const f of chain.toReversed()) {
		const code = sqlstate(f)
		if (code === undefined) continue
		return {
			code,
			column: text(f.column) ?? text(f.column_name),
			constraint: text(f.constraint) ?? text(f.constraint_name),
			...keyOf(text(f.detail)),
			message: text(f.message),
			/* the outermost wrapper's SQL: the statement as the app sent it */
			query: chain.map((each) => text(each.query)).find((query) => query !== undefined),
			/* anchored on the tail Postgres writes after the key values, which a value can spell */
			referenced: /\) is still referenced from table "(?:[^"]|"")+"\.$/.test(text(f.detail) ?? ""),
			schema: text(f.schema) ?? text(f.schema_name),
			table: text(f.table) ?? text(f.table_name),
		}
	}
	return null
}

export { type PgErrorRead, readPgError }
