/**
 * M78: public keeps the shared atlas_schema_revisions as its own history, where comb 0.12 also
 * recorded every other schema's files. A revision there that names no file of public's is another
 * schema's when the same version and hash sit in that schema's own history (M77 adopts them):
 * public ignores it, saying so, and keeps its own order. Every other revision with no file is
 * refused as gone (M76). The shared rows are never deleted.
 *
 * Atlas counts such a row as public's position and calls a file of public's older than it out of
 * order, so then the dry run and apply pass `--exec-order non-linear`, and checkHistory's late
 * check, over public's own revisions, keeps the order Atlas's check would have.
 *
 * Listing the schemas costs Atlas a read of every table's metadata: `--exclude '*.*'` filters
 * after reading (about half a second per 3000 tables on Postgres 17), and `--include` is Atlas
 * Pro's. It runs only while public holds such a revision, the one-time state after 0.12; comb has
 * no Postgres client of its own, and this is no reason for one.
 */
import { readInspect } from "./atlas-clean.ts"
import { type AtlasStatus, fileOf, filesOf } from "./atlas-history.ts"
import { atlasStatus, type AtlasCommand } from "./atlas-status.ts"
import { explainAtlasFailure, maskSecrets, type PgTarget, withAtlasEnv } from "./atlas-target.ts"
import { run } from "./process.ts"

/** Another schema's own history, by the prefix Atlas's per-schema histories share */
const OWN = "atlas_schema_revisions_"

/** What public's history holds of other schemas: each ignored version with its schema, or why they could not be read */
type Foreign = { ignored: Map<string, string>; unread: string | undefined }

/** No row of another schema's, nothing unread */
const none = (): Foreign => ({ ignored: new Map(), unread: undefined })

/** The names of the database's other schemas' own histories */
function histories(options: AtlasCommand): string[] {
	const ran = withAtlasEnv(options.target, { allSchemas: true, url: true }, (env) => {
		const args = [
			"schema",
			"inspect",
			"--url",
			"env://url",
			"--exclude",
			"*.*",
			"--format",
			"{{ json . }}",
			...env.args,
		]
		const result = (options.exec ?? run)("atlas", args, { env: env.env })
		if (result.code !== 0)
			throw new Error(
				`atlas schema inspect: ${explainAtlasFailure(result.stderr, env.scrub).trim() || `exit ${result.code}`}`,
			)
		/* the names as the database has them; only a printed line is masked (M79) */
		return readInspect(result.stdout)
	})
	return (ran.schemas ?? []).flatMap((schema) => (schema.name?.startsWith(OWN) === true ? [schema.name] : []))
}

/** The revisions of public's history `status` that are another schema's, read from those schemas' own histories */
function foreignRows(options: AtlasCommand, copy: string, status: AtlasStatus): Foreign {
	if (options.target.schema !== "public") return none()
	const fileless = status.applied.filter((revision) => fileOf(copy, revision.version) === revision.version)
	if (fileless.length === 0) return none()
	const own = new Map<string, string>()
	try {
		for (const name of histories(options)) {
			for (const revision of atlasStatus({ ...options, revisions: name }, copy, { notClean: true }).applied)
				own.set(`${revision.version} ${revision.hash}`, name.slice(OWN.length))
		}
	} catch (error) {
		// reason: a history comb cannot read leaves its rows unmatched, refused as gone with the reason
		return { ...none(), unread: (error as Error).message }
	}
	const ignored = fileless.flatMap((revision): Array<[string, string]> => {
		const schema = own.get(`${revision.version} ${revision.hash}`)
		return schema === undefined ? [] : [[revision.version, schema]]
	})
	return { ignored: new Map(ignored), unread: undefined }
}

/**
 * `status` as public's own history, without `foreign`'s rows: its position, its files and pending
 * files from the snapshot `copy` (Atlas lists none once it calls one out of order), and no
 * out-of-order error those rows caused
 */
function ownHistory(status: AtlasStatus, { ignored }: Foreign, copy: string): AtlasStatus {
	if (ignored.size === 0) return status
	const applied = status.applied.filter((revision) => !ignored.has(revision.version))
	const recorded = new Set(applied.map((revision) => revision.version))
	const current = applied.at(-1)?.version ?? ""
	const available = filesOf(copy)
	const pending = available.filter((file) => !recorded.has(file.Version) && file.Version > current)
	const error = /was added out of order/.test(status.error) ? "" : status.error
	return { ...status, applied, available, current, error, pending }
}

/** What public says of each row it ignores, the target's secrets masked where a schema's name holds one (M79) */
const ignoredLines = ({ ignored }: Foreign, target: PgTarget): string[] =>
	[...ignored].map(([version, schema]) => {
		/* only the schema's name, a value the database holds, is masked: comb's words stay as written */
		const name = maskSecrets(schema, [target.url, target.devUrl])
		return `${version} is schema ${name}'s, recorded in ${OWN}${name}; public ignores it`
	})

/** The flag the dry run and apply need when public ignores a row: Atlas would count it as public's position */
const execOrder = ({ ignored }: Foreign): string[] => (ignored.size > 0 ? ["--exec-order", "non-linear"] : [])

export { execOrder, type Foreign, foreignRows, ignoredLines, ownHistory }
