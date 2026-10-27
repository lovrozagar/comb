/**
 * Atlas's migrate commands on a Postgres target, run on comb's snapshot of the directory: each
 * through an Atlas config that keeps the URL in the environment, its output scrubbed, and its
 * status read through a template that never selects the URL.
 */
import type { AtlasStatus } from "./atlas-history.ts"
import { explainAtlasFailure, type PgTarget, scrubAtlasOutput, withAtlasEnv } from "./atlas-target.ts"
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

/**
 * What an Atlas call returned, as Atlas wrote it, for comb's decisions; `said`, its stderr as comb
 * prints it (explained, then scrubbed); `scrub`, for any other text comb prints of it
 */
type Ran = RunResult & { said: string; scrub(text: string): string }

/**
 * `atlas migrate <args>` on the snapshot `copy` against the target. Its stdout is JSON comb parses
 * as written, its stderr too, and never scrubbed (M79), since a secret that spells a key, a name or
 * a word Atlas prints would change what comb reads; a caller scrubs a value only where it prints it.
 */
function atlas(options: AtlasCommand, copy: string, args: readonly string[]): Ran {
	return withAtlasEnv(options.target, { revisions: options.revisions, url: true }, (env) => {
		const ran = (options.exec ?? run)("atlas", ["migrate", ...args, "--dir", `file://${copy}`, ...env.args], {
			env: env.env,
		})
		return { ...ran, said: explainAtlasFailure(ran.stderr, env.scrub), scrub: env.scrub }
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
	if (ran.code !== 0 && notClean && /connected database is not clean/.test(ran.stderr)) return NO_HISTORY
	if (ran.code !== 0)
		throw new Error(`atlas migrate status: ${ran.said || `exit ${ran.code}: ${ran.scrub(ran.stdout)}`}`)
	/* as Atlas wrote it: what comb prints of it is scrubbed where it prints it (checkHistory's `scrub`) */
	return json<AtlasStatus>(ran.stdout, "status")
}

/** The scrubber for text comb prints of `target`'s Atlas calls, outside one */
const scrubbing =
	(target: PgTarget) =>
	(text: string): string =>
		scrubAtlasOutput(text, [target.url, target.devUrl])

export { atlas, type AtlasCommand, atlasStatus, json, NO_HISTORY, type Ran, scrubbing }
