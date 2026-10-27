/**
 * Atlas's migrate commands on a Postgres target, run on comb's snapshot of the directory: each
 * through an Atlas config that keeps the URL in the environment, its output scrubbed, and its
 * status read through a template that never selects the URL.
 */
import type { AtlasStatus } from "./atlas-history.ts"
import { explainAtlasFailure, type PgTarget, withAtlasEnv } from "./atlas-target.ts"
import { type Run, type RunResult, run } from "./process.ts"

const STATUS_FORMAT =
	'{"status":{{ json .Status }},"current":{{ json .Current }},"available":{{ json .Available }},"pending":{{ json .Pending }},' +
	'"applied":[{{ range $i, $r := .Applied }}{{ if $i }},{{ end }}{"version":{{ json $r.Version }},"type":{{ json $r.Type }},' +
	'"description":{{ json $r.Description }},"applied":{{ json $r.Applied }},"total":{{ json $r.Total }},"error":{{ json $r.Error }},"errorStmt":{{ json $r.ErrorStmt }},' +
	'"hash":{{ json $r.Hash }}}{{ end }}],"error":{{ json .Error }}}'

/** What every Atlas command on a Postgres database needs: the directory, the target, and where to report */
type AtlasCommand = {
	dir: string
	/** The process runner; tests pass a fake. */
	exec?: Run | undefined
	print(line: string): void
	/** a history other than the target's own, by its schema: 0.12's shared one (M77), or another schema's own (M78) */
	revisions?: string | undefined
	target: PgTarget
}

/** `atlas migrate <args>` on the snapshot `copy` against the target, its output scrubbed */
function atlas(options: AtlasCommand, copy: string, args: readonly string[]): RunResult {
	return withAtlasEnv(options.target, { revisions: options.revisions, url: true }, (env) => {
		const ran = (options.exec ?? run)("atlas", ["migrate", ...args, "--dir", `file://${copy}`, ...env.args], {
			env: env.env,
		})
		return { ...ran, stderr: explainAtlasFailure(env.scrub(ran.stderr)), stdout: env.scrub(ran.stdout) }
	})
}

/** `text` parsed as `command`'s JSON, or an error that does not echo what Atlas printed */
function json<T>(text: string, command: string): T {
	try {
		return JSON.parse(text) as T
	} catch {
		// reason: unreadable output may hold anything Atlas printed, so it is not repeated
		throw new Error(`unexpected output from atlas migrate ${command}`)
	}
}

const NO_HISTORY: AtlasStatus = { applied: [], available: [], current: "", error: "", pending: [], status: "PENDING" }

/**
 * Atlas's status for the snapshot `copy`. With `notClean`, a database that has objects but no
 * history reads as having none recorded: Atlas refuses its status once a refused apply left an
 * empty history table, and that database is the one baseline and adoption are for.
 */
function atlasStatus(
	options: AtlasCommand,
	copy: string,
	{ notClean = false }: { notClean?: boolean } = {},
): AtlasStatus {
	const ran = atlas(options, copy, ["status", "--format", STATUS_FORMAT])
	if (ran.code !== 0 && notClean && ran.stderr === explainAtlasFailure("connected database is not clean"))
		return NO_HISTORY
	if (ran.code !== 0) throw new Error(`atlas migrate status: ${ran.stderr || `exit ${ran.code}: ${ran.stdout}`}`)
	return json<AtlasStatus>(ran.stdout, "status")
}

export { atlas, type AtlasCommand, atlasStatus, json, NO_HISTORY }
