/**
 * Public keeps the shared atlas_schema_revisions as its own history, where comb 0.12 also
 * recorded every other schema's files. A revision there that names no file of public's is another
 * schema's when the same version and hash sit in that schema's own history (apply and baseline
 * adopt them): public ignores it, saying so, and keeps its own order. Every other revision with no
 * file is refused as gone. The shared rows are never deleted.
 *
 * ownHistory leaves such a row out of public's position, which every apply reads by name.
 *
 * Listing the schemas costs Atlas a read of every table's metadata: `--exclude '*.*'` filters
 * after reading (about half a second per 3000 tables on Postgres 17), and `--include` is Atlas
 * Pro's. It runs only while public holds such a revision, the one-time state after 0.12; comb has
 * no Postgres client of its own, and this is no reason for one.
 */
import { readInspect } from "./atlas-clean.ts"
import { type AtlasStatus, fileOf, filesOf, lastApplied } from "./atlas-history.ts"
import { atlasStatus, type AtlasCommand } from "./atlas-status.ts"
import { explainAtlasFailure } from "./atlas-failure.ts"
import { type PgTarget, SHARED_REVISIONS, withAtlasEnv } from "./atlas-target.ts"
import { maskSecrets } from "./atlas-secrets.ts"
import { run } from "./process.ts"

/** Another schema's own history, by the prefix Atlas's per-schema histories share */
const OWN = "atlas_schema_revisions_"

/**
 * What public's history holds of other schemas: each ignored version with its schema, or why they
 * could not be read; `elsewhere` when the database holds a schema but public, so a row no own
 * history matches may be one comb 0.12 recorded for it, not yet adopted
 */
type Foreign = { elsewhere: boolean; ignored: Map<string, string>; unread: string | undefined }

/** No row of another schema's, nothing unread */
const none = (): Foreign => ({ elsewhere: false, ignored: new Map(), unread: undefined })

/** The names of the database's schemas */
async function schemasOf(options: AtlasCommand): Promise<string[]> {
	const ran = await withAtlasEnv(options.target, { allSchemas: true, url: true }, async (env) => {
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
		const result = await (options.exec ?? run)("atlas", args, { env: env.env })
		if (result.code !== 0)
			throw new Error(
				`atlas schema inspect: ${explainAtlasFailure(result.stderr, env.scrub).trim() || `exit ${result.code}`}`,
			)
		/* the names as the database has them; only a printed line is masked */
		return readInspect(result.stdout)
	})
	return (ran.schemas ?? []).flatMap((schema) => (schema.name === undefined ? [] : [schema.name]))
}

/** The revisions of public's history `status` that are another schema's, read from those schemas' own histories */
async function foreignRows(options: AtlasCommand, copy: string, status: AtlasStatus): Promise<Foreign> {
	if (options.target.schema !== "public") return none()
	const fileless = status.applied.filter((revision) => fileOf(copy, revision.version) === revision.version)
	if (fileless.length === 0) return none()
	const own = new Map<string, string>()
	let elsewhere = false
	try {
		const schemas = await schemasOf(options)
		elsewhere = schemas.some((name) => name !== "public" && name !== SHARED_REVISIONS)
		for (const name of schemas.filter((each) => each.startsWith(OWN))) {
			for (const revision of (await atlasStatus({ ...options, revisions: name }, copy, { notClean: true })).applied)
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
	return { elsewhere, ignored: new Map(ignored), unread: undefined }
}

/**
 * `status` as the target's own history, without `foreign`'s rows, ordered by name alone, as comb
 * orders files on SQLite and Atlas runs them under `--exec-order non-linear`: pending is the file Atlas
 * ran halfway, then each file never applied that sorts after the last applied one, from the snapshot
 * `copy`. Atlas's linear order compares versions, so its status lists other files and calls a later
 * name with a lower version out of order; that error is dropped, and checkHistory refuses a file named
 * before the last applied one, which Atlas skips without a word
 */
function ownHistory(status: AtlasStatus, { ignored }: Foreign, copy: string): AtlasStatus {
	const applied = status.applied.filter((revision) => !ignored.has(revision.version))
	const recorded = new Set(applied.map((revision) => revision.version))
	const half = applied.find((revision) => revision.applied < revision.total && revision.error !== "")?.version
	const last = lastApplied(applied) ?? ""
	const available = filesOf(copy)
	const pending = available.filter((file) => file.Version === half || (!recorded.has(file.Version) && file.Name > last))
	const error = /was added out of order/.test(status.error) ? "" : status.error
	return { ...status, applied, available, current: applied.at(-1)?.version ?? "", error, pending }
}

/** What public says of each row it ignores, the target's secrets masked where a schema's name holds one */
const ignoredLines = ({ ignored }: Foreign, target: PgTarget): string[] =>
	[...ignored].map(([version, schema]) => {
		/* only the schema's name, a value the database holds, is masked: comb's words stay as written */
		const name = maskSecrets(schema, [target.url, target.devUrl])
		return `${version} is schema ${name}'s, recorded in ${OWN}${name}; public ignores it`
	})

export { type Foreign, foreignRows, ignoredLines, ownHistory }
