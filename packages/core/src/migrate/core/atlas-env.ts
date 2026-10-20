/**
 * What every SQLite Atlas run shares: the dev database it replays on, and the pragma rewrite and
 * rebuild guard applied to what it writes.
 */
import { randomUUID } from "node:crypto"
import type { ExtractedSchema } from "../types.ts"
import type { FtsState } from "./fts-migration.ts"
import { guardRebuilds } from "./rebuild-guard.ts"

/* ═══════════════════════════════════════════════════════════════════════════
   SQLITE MIGRATION POST-PROCESSOR

   Atlas emits SQLite table-rewrite diffs wrapped in
   `PRAGMA foreign_keys = off;` / `PRAGMA foreign_keys = on;`. That pattern
   fails on fresh DBs when a CREATE references a table created LATER in the
   same diff, and D1 ignores the pragma inside its transaction. Swap for
   `PRAGMA defer_foreign_keys = on;` (standard SQLite, libsql, D1): FK checks
   deferred to commit, when every table exists. The pragma defers checks,
   never ON DELETE actions, so a rebuild of a table others reference is also
   guarded (rebuild-guard.ts), or its DROP TABLE would delete their rows.
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Idempotent. Input without the pragma pair passes through unchanged. With `before`, the schema
 * the earlier migrations leave, each rebuild of a referenced table is guarded, and FTS triggers in
 * `fts` are the ones the guard may fire; a rebuild it cannot guard is refused.
 */
export function applySqliteMigrationTransforms(sql: string, before?: ExtractedSchema, fts?: FtsState): string {
	/* Opening: optional "-- Disable ..." comment + PRAGMA foreign_keys = off; */
	let out = sql.replace(
		/(?:^|\n)(?:[ \t]*-- Disable the enforcement of foreign-keys constraints[ \t]*\n)?[ \t]*PRAGMA[ \t]+foreign_keys[ \t]*=[ \t]*off[ \t]*;[ \t]*\n?/i,
		(match) => `${match.startsWith("\n") ? "\n" : ""}PRAGMA defer_foreign_keys = on;\n`,
	)

	/* Closing: optional "-- Enable back ..." comment + PRAGMA foreign_keys = on; */
	out = out.replace(
		/(?:[ \t]*-- Enable back the enforcement of foreign-keys constraints[ \t]*\n)?[ \t]*PRAGMA[ \t]+foreign_keys[ \t]*=[ \t]*on[ \t]*;[ \t]*\n?/i,
		"",
	)

	return guardRebuilds(out, before, fts)
}

/* ═══════════════════════════════════════════════════════════════════════════
   SQLITE EXPORT NORMALIZATION

   drizzle-kit 1.0.0-rc.4 exports a SQLite primary key without NOT NULL
   (`text("id").primaryKey()` is `` `id` text PRIMARY KEY ``, `.notNull()`
   changes nothing), and SQLite lets every key but a rowid alias hold NULL.
   Atlas reads such a column as nullable, so a history that says NOT NULL
   would be rebuilt on every diff. comb gives each such column its NOT NULL.
   ═══════════════════════════════════════════════════════════════════════════ */

/* a column line of an export: `\t`name` type…`, its name doubled-backtick escaped */
const COLUMN_LINE = /^\t`((?:[^`]|``)+)` ([a-z]+)\b/i
/* a table-level primary key line: `\t[CONSTRAINT `n` ]PRIMARY KEY(`a`, `b`)` */
const TABLE_KEY = /^\t(?:CONSTRAINT `(?:[^`]|``)+` )?PRIMARY KEY ?\(([^)]*)\)/i

/** The table body lines that need NOT NULL for a table-level primary key, given the body's lines */
function keyColumns(lines: readonly string[]): Set<string> {
	const listed = lines.flatMap((line) => {
		const list = TABLE_KEY.exec(line)?.[1]
		return list === undefined
			? []
			: [list.split(",").map((part) => part.trim().replace(/^`|`$/g, "").replaceAll("``", "`"))]
	})
	const columns = new Set<string>()
	for (const key of listed) {
		const lone = key.length === 1 ? lines.find((line) => COLUMN_LINE.exec(line)?.[1] === key[0]) : undefined
		/* a lone integer key is the rowid alias, which never holds NULL */
		if (lone !== undefined && /^integer$/i.test(COLUMN_LINE.exec(lone)?.[2] as string)) continue
		for (const column of key) columns.add(column)
	}
	return columns
}

/** One CREATE TABLE of an export with NOT NULL on each column of its table-level primary key */
function withKeyNotNull(table: string): string {
	const lines = table.split("\n")
	const columns = keyColumns(lines)
	return lines
		.map((line) => {
			const name = COLUMN_LINE.exec(line)?.[1]
			if (name === undefined || !columns.has(name) || /\bNOT NULL\b/i.test(line)) return line
			return line.replace(/(,?)$/, " NOT NULL$1")
		})
		.join("\n")
}

/** drizzle-kit's SQLite export with NOT NULL on every primary key column but a rowid alias; idempotent */
export function normalizeSqliteExport(sql: string): string {
	const inline = sql.replace(
		/^(\t`(?:[^`]|``)+` (?!integer\b)[a-z]+(?:\([^)]*\))?) PRIMARY KEY\b(?![^\n]*\bNOT NULL\b)/gim,
		"$1 NOT NULL PRIMARY KEY",
	)
	return inline.replace(/^CREATE TABLE [^\n]*\(\n[\s\S]*?\n\);/gm, withKeyNotNull)
}

/**
 * The ephemeral database Atlas replays SQLite migrations on; Postgres names its own
 * (atlas-target.ts). Atlas takes a lock across the host named after the dev URL, so each run
 * gets a database name of its own, or two diffs at once fail with "lock … already taken".
 */
export const sqliteDevUrl = (): string => `sqlite://comb-${randomUUID()}?mode=memory`
