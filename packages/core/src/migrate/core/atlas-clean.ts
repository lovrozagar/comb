/**
 * Whether a Postgres database is one Atlas would call clean: comb's check refuses what Atlas's
 * apply refuses, without the dry run, which writes Atlas's revisions schema. comb binds every Atlas
 * URL to the target's schema (`search_path`), and Atlas calls a bound target clean while its schema
 * holds no table. Atlas OSS inspects no view or function, so those do not count.
 */
import { explainAtlasFailure, type PgTarget, withAtlasEnv } from "./atlas-target.ts"
import type { Run } from "./process.ts"

/** The schemas `atlas schema inspect` reports, by name, with their tables */
type Inspected = { schemas?: Array<{ name?: string; tables?: unknown[] }> }

/**
 * Atlas's inspect JSON `stdout`, parsed as Atlas wrote it and never scrubbed (M79): its names are
 * the database's, used as they are, and a caller masks a value only where it prints it, since a
 * secret that spells a name or a key would otherwise change what comb reads
 */
function readInspect(stdout: string): Inspected {
	try {
		return JSON.parse(stdout) as Inspected
	} catch {
		// reason: unreadable output may hold anything Atlas printed, so it is not repeated
		throw new Error("unexpected output from atlas schema inspect")
	}
}

/** Refuses, with apply's baseline message, a database Atlas would call not clean; reads only */
function refuseUnclean(options: { exec: Run; target: PgTarget }): void {
	const { schemas = [] } = withAtlasEnv(options.target, { url: true }, (env) => {
		const args = ["schema", "inspect", "--url", "env://url", "--format", "{{ json . }}", ...env.args]
		const result = options.exec("atlas", args, { env: env.env })
		/* a failure's output is free text, scrubbed; a success's is JSON, parsed before anything is masked */
		if (result.code !== 0)
			throw new Error(
				`atlas schema inspect: ${`${env.scrub(`${explainAtlasFailure(result.stderr)}${result.stdout}`)}`.trim()}`,
			)
		return readInspect(result.stdout)
	})
	if (schemas.some((schema) => (schema.tables ?? []).length > 0))
		throw new Error(explainAtlasFailure("connected database is not clean"))
}

export { type Inspected, readInspect, refuseUnclean }
