/**
 * What every Atlas run shares: the dev database it replays on, and the SQLite pragma rewrite
 * applied to what it writes.
 */
import type { Dialect } from "../types.ts"

/* ═══════════════════════════════════════════════════════════════════════════
   SQLITE MIGRATION POST-PROCESSOR

   Atlas emits SQLite table-rewrite diffs wrapped in
   `PRAGMA foreign_keys = off;` / `PRAGMA foreign_keys = on;`. That pattern
   fails on fresh DBs when a CREATE references a table created LATER in the
   same diff. Swap for `PRAGMA defer_foreign_keys = on;` (standard SQLite,
   libsql, D1) — FK enforcement deferred to commit; every table exists by then.
   ═══════════════════════════════════════════════════════════════════════════ */

/** Idempotent. Input without the pragma pair passes through unchanged. */
export function applySqliteMigrationTransforms(sql: string): string {
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

	return out
}

/* ═══════════════════════════════════════════════════════════════════════════
   DEV URL FOR DIALECT
   ═══════════════════════════════════════════════════════════════════════════ */

/** The ephemeral database Atlas replays migrations on */
export function devUrl(dialect: Dialect): string {
	return dialect === "sqlite" ? "sqlite://file?mode=memory" : "postgres://localhost:5432/dev?sslmode=disable"
}
