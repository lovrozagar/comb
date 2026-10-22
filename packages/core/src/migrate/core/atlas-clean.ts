/**
 * Whether a Postgres database is one Atlas would call clean: comb's check refuses what Atlas's
 * apply refuses, without the dry run, which writes Atlas's revisions schema. comb binds every Atlas
 * URL to the target's schema (`search_path`), and Atlas calls a bound target clean while its schema
 * holds no table. Atlas OSS inspects no view or function, so those do not count.
 */
import { explainAtlasFailure, type PgTarget, withAtlasEnv } from "./atlas-target.ts"
import type { Run } from "./process.ts"

/** The schemas `atlas schema inspect` reports, with their tables */
type Inspected = { schemas?: Array<{ tables?: unknown[] }> }

/** Refuses, with apply's baseline message, a database Atlas would call not clean; reads only */
function refuseUnclean(options: { exec: Run; target: PgTarget }): void {
	const ran = withAtlasEnv(options.target, { url: true }, (env) => {
		const args = ["schema", "inspect", "--url", "env://url", "--format", "{{ json . }}", ...env.args]
		const result = options.exec("atlas", args, { env: env.env })
		return { ...result, stderr: explainAtlasFailure(env.scrub(result.stderr)), stdout: env.scrub(result.stdout) }
	})
	if (ran.code !== 0) throw new Error(`atlas schema inspect: ${`${ran.stderr}${ran.stdout}`.trim()}`)
	const { schemas = [] } = JSON.parse(ran.stdout) as Inspected
	if (schemas.some((schema) => (schema.tables ?? []).length > 0))
		throw new Error(explainAtlasFailure("connected database is not clean"))
}

export { refuseUnclean }
