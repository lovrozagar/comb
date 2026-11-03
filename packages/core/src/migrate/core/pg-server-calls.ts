/**
 * The functions that act on the server or past the replay's database (PR2 of r22b): called where a
 * statement runs them, they reach as far as the statements in BEYOND (pg-outside-transaction.ts) do,
 * so the dev replay leaves the statement out and apply alone runs it. The list holds every pg_catalog
 * function Postgres 17 revokes from PUBLIC that does more than read, which a test holds it to
 * against pg_proc, and the ones it grants by role instead: a backend's signals and a replication
 * slot's work. dblink's are named whatever schema holds them, as a second connection's work is
 * whatever it sends, and as a family, by the prefix: a connection left out leaves its cursor's open,
 * fetch and close, and its disconnect, nothing to reach, so each is left out with it.
 */

// lookup-table: each pg_catalog function that acts on the server or past the database, by its name
const SERVER_CALLS: ReadonlySet<string> = /* @__PURE__ */ new Set([
	"lo_export",
	"pg_backup_start",
	"pg_backup_stop",
	"pg_cancel_backend",
	"pg_copy_logical_replication_slot",
	"pg_copy_physical_replication_slot",
	"pg_create_logical_replication_slot",
	"pg_create_physical_replication_slot",
	"pg_create_restore_point",
	"pg_drop_replication_slot",
	"pg_log_backend_memory_contexts",
	"pg_log_standby_snapshot",
	"pg_logical_emit_message",
	"pg_logical_slot_get_binary_changes",
	"pg_logical_slot_get_changes",
	"pg_promote",
	"pg_reload_conf",
	"pg_replication_origin_advance",
	"pg_replication_origin_create",
	"pg_replication_origin_drop",
	"pg_replication_origin_session_reset",
	"pg_replication_origin_session_setup",
	"pg_replication_origin_xact_reset",
	"pg_replication_origin_xact_setup",
	"pg_replication_slot_advance",
	"pg_rotate_logfile",
	"pg_stat_reset",
	"pg_stat_reset_replication_slot",
	"pg_stat_reset_shared",
	"pg_stat_reset_single_function_counters",
	"pg_stat_reset_single_table_counters",
	"pg_stat_reset_slru",
	"pg_stat_reset_subscription_stats",
	"pg_switch_wal",
	"pg_sync_replication_slots",
	"pg_terminate_backend",
	"pg_wal_replay_pause",
	"pg_wal_replay_resume",
])

/** The first function in the parse tree `tree` that acts on the server, by its name, as written */
function serverCallIn(tree: unknown): string | undefined {
	if (tree === null || typeof tree !== "object") return undefined
	const call = (tree as { FuncCall?: { funcname: Array<{ String?: { sval: string } | undefined }> } | undefined })
		.FuncCall
	const name = call?.funcname.at(-1)?.String?.sval
	if (name !== undefined && (SERVER_CALLS.has(name) || name === "dblink" || name.startsWith("dblink_"))) return name
	for (const value of Object.values(tree)) {
		const found = serverCallIn(value)
		if (found !== undefined) return found
	}
	return undefined
}

export { SERVER_CALLS, serverCallIn }
