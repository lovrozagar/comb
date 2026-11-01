/**
 * The target schema on the dev database (P12 of the 0.14.1 review). Atlas scopes the dev URL to
 * the target schema and inspects it before it replays anything, so a dev database without it
 * fails every diff, replay and adoption proof, and nothing a migration holds can create it: comb
 * creates it there first. devUrl is Atlas's scratch, which Atlas requires empty and cleans, so
 * this one write asks no trust Atlas does not take already. A docker:// dev is Atlas's own
 * container, left alone: whether Atlas makes the schema there is unverified (p15-summary).
 */
import { sqlIdentifier } from "../../codegen/utils/case.ts"
import { maskSecrets } from "./atlas-secrets.ts"
import { type PgTarget, refuseUrlProblems } from "./atlas-target.ts"
import { ReplayFailed } from "./replay-failed.ts"
import { type Connect, failureOf, loadPostgres } from "./pg-live-objects.ts"
import { postgresOptionsOf } from "./pg-url.ts"

/** How a dev database gets the target schema: comb's own, readyDevSchema, unless a test fakes it */
type ReadyDev = (target: PgTarget) => Promise<void>

/* why comb loads postgres.js here */
const CREATES = "a non-public schema needs the `postgres` package to create it on devUrl"

/**
 * Create `target`'s schema on its dev database, unless it is public or the dev is Atlas's docker
 * container; a devUrl comb refuses is refused first, whatever the schema, so nothing reaches it (P2 of r19)
 */
async function readyDevSchema(
	target: PgTarget,
	load: () => Promise<Connect> = () => loadPostgres(CREATES),
): Promise<void> {
	refuseUrlProblems(target, { dev: true })
	if (target.schema === "public" || target.devUrl.startsWith("docker:")) return
	const connect = await load()
	let sql: ReturnType<Connect> | undefined
	try {
		sql = connect({ ...postgresOptionsOf(target.devUrl, "devUrl"), max: 1, onnotice: () => undefined })
		await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${sqlIdentifier(target.schema)}`, [])
	} catch (error) {
		throw new ReplayFailed(
			`comb could not create schema ${target.schema} on devUrl, where Atlas replays the migrations: ${maskSecrets(failureOf(error, "devUrl", target.devUrl), [target.devUrl])}`,
			{ cause: error },
		)
	} finally {
		await sql?.end()
	}
}

export { type ReadyDev, readyDevSchema }
