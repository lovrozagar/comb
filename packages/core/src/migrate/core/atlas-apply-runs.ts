/**
 * The apply itself, once comb approved the pending files: one Atlas call per run of files that may
 * share a session (PA1 of r22b, pg-session.ts), so a session setting one file makes ends with its
 * run, as on SQLite (S1 of r21) and on D1, and a run of files that leave it as they found it costs
 * one call.
 */
import { hold } from "./cleanup.ts"
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
async function ranNothing(
	options: AtlasCommand,
	copy: string,
	{ applied, foreign }: { applied: string[]; foreign: Foreign },
) {
	const { pending } = ownHistory(await atlasStatus(options, copy), foreign, copy)
	if (pending.length > 0) {
		const names = pending.map((file) => file.Name).join(", ")
		throw new Error(`atlas migrate apply ran nothing and reported no error, yet still pending: ${names}`)
	}
	if (applied.length === 0) options.print("No migrations to apply")
	return applied
}

/**
 * What SIGINT or SIGTERM runs once it stopped this apply's Atlas call and that call ended (cleanup.ts
 * runs a child's step before this one, PA4 of r22): the history read once more, and which approved
 * files it records and which it does not, printed; no further call starts, and the process then ends
 * by the signal
 */
const stoppedBy =
	(options: AtlasCommand, copy: string, { approved, foreign }: { approved: ReadonlySet<string>; foreign: Foreign }) =>
	async (signal: NodeJS.Signals): Promise<void> => {
		try {
			const { pending } = ownHistory(await atlasStatus(options, copy), foreign, copy)
			const left = new Set(pending.map((file) => file.Name))
			const [ran, not] = [
				[...approved].filter((name) => !left.has(name)),
				[...approved].filter((name) => left.has(name)),
			]
			options.print(
				`Stopped by ${signal}: applied ${ran.join(", ") || "none"}; not applied ${not.join(", ") || "none"}`,
			)
		} catch (error) {
			// reason: a history read that fails must not hide the stop: the line says what comb could not read, and the process still ends by the signal
			options.print(`Stopped by ${signal}: comb could not read what was applied: ${(error as Error).message}`)
		}
	}

/**
 * The pending files of `status`, which comb approved, applied one Atlas call per run of them
 * (sessionRuns): Atlas runs a call's files on one session, where a SET one file makes outlives its
 * COMMIT and reaches the next, a lifted lock_timeout among them, while comb rates each file alone.
 * Each later call reads the status and checks the history again first, the guard against another
 * apply between calls, and runs the first run of what is still pending; each runs approved files
 * not yet run, so the calls are at most the approved files
 */
async function applyRuns(
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
): Promise<string[]> {
	const approved = new Set(status.pending.map((file) => file.Name))
	const release = hold(stoppedBy(options, copy, { approved, foreign }))
	try {
		return await callRuns(options, copy, { approved, files, foreign, report, server })
	} finally {
		release()
	}
}

/** applyRuns' calls, each the first run of what is still pending, until every approved file ran */
async function callRuns(
	options: AtlasCommand,
	copy: string,
	{
		approved,
		files,
		foreign,
		report,
		server,
	}: Omit<Parameters<typeof applyRuns>[2], "status"> & { approved: ReadonlySet<string> },
): Promise<string[]> {
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
			await atlas(options, copy, ["apply", ...execOrder(foreign), "--format", APPLY_FORMAT, String(names.length)]),
			"apply",
			copy,
		)
		if (ran.length === 0) return await ranNothing(options, copy, { applied, foreign })
		if (ran.join("\n") !== names.join("\n"))
			throw new Error(`atlas migrate apply ${names.length} ran ${ran.join(", ")}, not the approved ${names.join(", ")}`)
		for (const name of ran) options.print(`Apply: ${name}`)
		applied.push(...ran)
		if (applied.length === approved.size) break
		const now = ownHistory(await atlasStatus(options, copy), foreign, copy)
		checkHistory(now, copy, report)
		pending = now.pending.map((file) => file.Name)
		/* another apply ran the rest */
		if (pending.length === 0) break
	}
	return applied
}

export { applyRuns }
