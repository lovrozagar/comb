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

/**
 * The ephemeral database Atlas replays SQLite migrations on; Postgres names its own
 * (atlas-target.ts). Atlas takes a lock across the host named after the dev URL, so each run
 * gets a database name of its own, or two diffs at once fail with "lock … already taken".
 */
export const sqliteDevUrl = (): string => `sqlite://comb-${randomUUID()}?mode=memory`
