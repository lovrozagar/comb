/**
 * Another process's write lock on a local D1 file, as comb meets it through wrangler: the D1 driver waits a command
 * out, and a failed apply names it.
 */

/** how long a --local command waits out another process's lock on the local D1 file: BUSY_TIMEOUT's window for a SQLite file (SL4 of r22) */
export const LOCAL_LOCK_MS = 5000

/**
 * workerd's error for a local D1 file another process holds the write lock on, which wrangler prints colored
 * without --json: SQLITE_BUSY exactly, never "locked" in another sense
 */
export const LOCAL_BUSY: RegExp = /database is locked: SQLITE_BUSY(?!\w)/

/** who holds a local D1 file's write lock when comb meets it */
export const LOCKER = "another process (wrangler dev, a wrangler command or a second comb migrate)"
