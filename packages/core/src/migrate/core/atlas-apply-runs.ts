/**
 * The apply itself, once comb approved the pending files: one Atlas call per run of files that may
 * share a session (PA1 of r22b, pg-session.ts), so a session setting one file makes ends with its
 * run, as on SQLite (S1 of r21) and on D1, and a run of files that leave it as they found it costs
 * one call.
 */
import { execOrder, type Foreign, ownHistory } from "./atlas-foreign.ts"
import { type AtlasStatus, checkHistory } from "./atlas-history.ts"
import { APPLY_FORMAT, reported } from "./atlas-report.ts"
import { atlas, type AtlasCommand, atlasStatus } from "./atlas-status.ts"
import type { ServerCode } from "./pg-server-code.ts"
import { sessionRuns } from "./pg-session.ts"
import type { PgRead } from "./pg-split.ts"

/**
 * After an Atlas call that ran no file and said nothing, once this apply ran `applied`: done once
 * another apply ran the rest, refused while any is pending (P8)
 */
function ranNothing(
	options: AtlasCommand,
	copy: string,
	{ applied, foreign }: { applied: string[]; foreign: Foreign },
) {
	const { pending } = ownHistory(atlasStatus(options, copy), foreign, copy)
	if (pending.length > 0) {
		const names = pending.map((file) => file.Name).join(", ")
		throw new Error(`atlas migrate apply ran nothing and reported no error, yet still pending: ${names}`)
	}
	if (applied.length === 0) options.print("No migrations to apply")
	return applied
}

/**
 * The pending files of `status`, which comb approved, applied one Atlas call per run of them
 * (sessionRuns): Atlas runs a call's files on one session, where a SET one file makes outlives its
 * COMMIT and reaches the next, a lifted lock_timeout among them, while comb rates each file alone.
 * Each later call reads the status and checks the history again first, the guard against another
 * apply between calls, and runs the first run of what is still pending; each runs approved files
 * not yet run, so the calls are at most the approved files
 */
function applyRuns(
	options: AtlasCommand,
	copy: string,
	{
		files,
		foreign,
		report,
		server,
		status,
	}: {
		/** every file of the snapshot as comb read it, whose definitions resolve each run's calls */
		files: ReadonlyArray<{ name: string; read: PgRead }>
		foreign: Foreign
		report: Parameters<typeof checkHistory>[2]
		/** the code the target holds, which every file may run */
		server: ServerCode
		status: AtlasStatus
	},
): string[] {
	const approved = new Set(status.pending.map((file) => file.Name))
	const applied: string[] = []
	let pending = [...approved]
	while (applied.length < approved.size) {
		/* the pending are never none here, so they hold a first run */
		const [run] = sessionRuns(
			files.filter((file) => pending.includes(file.name)),
			files,
			server,
		) as [Array<(typeof files)[number]>]
		const names = run.map((file) => file.name)
		const ran = reported(
			atlas(options, copy, ["apply", ...execOrder(foreign), "--format", APPLY_FORMAT, String(names.length)]),
			"apply",
			copy,
		)
		if (ran.length === 0) return ranNothing(options, copy, { applied, foreign })
		if (ran.join("\n") !== names.join("\n"))
			throw new Error(`atlas migrate apply ${names.length} ran ${ran.join(", ")}, not the approved ${names.join(", ")}`)
		for (const name of ran) options.print(`Apply: ${name}`)
		applied.push(...ran)
		if (applied.length === approved.size) break
		const now = ownHistory(atlasStatus(options, copy), foreign, copy)
		checkHistory(now, copy, report)
		pending = now.pending.map((file) => file.Name)
		/* another apply ran the rest */
		if (pending.length === 0) break
	}
	return applied
}

export { applyRuns }
