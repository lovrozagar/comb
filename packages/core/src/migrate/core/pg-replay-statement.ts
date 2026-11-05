/**
 * One statement of a history file as the dev replay runs it (pg-replay.ts): a statement on roles as
 * pg-replay-made.ts runs it, one in a tablespace the replay left out in pg_default
 * (pg-replay-tablespaces.ts), and any other as it is, with the words the replay reports it in.
 */
import type { Sql } from "./pg-replay-database.ts"
import { runRole } from "./pg-replay-made.ts"
import type { Run } from "./pg-replay-roles.ts"
import { inDefault } from "./pg-replay-tablespaces.ts"
import type { ReplayFailed } from "./replay-failed.ts"

/** How the replay words what it does, and where it says what it left out */
type Replay = {
	/** what the replay was doing, as a refusal names it */
	doing: string
	/** a statement left out, from `file`, and what it is */
	leftOut(file: string, sent: string, what: string): void
	/** a CREATE ROLE or ALTER ROLE `sent` from `file` the replay ran without some of what it says */
	madeBare?: ((file: string, sent: string) => void) | undefined
	/** a statement `sent` from `file` the replay ran in pg_default, not in the tablespaces `names` it left out */
	movedTo?: ((file: string, sent: string, names: readonly string[]) => void) | undefined
	/** a role `file` added inside a statement the replay cannot leave out, adopted as one it made */
	adopted?: ((file: string, role: string) => void) | undefined
	/** what a refusal stops */
	stops: string
}

/** A refusal: what failed, with devUrl's error, and what that stops */
type Refuse = (what: string, error: unknown) => ReplayFailed

/** A replay's run of each file: the refusal it words, and the extensions waiting on one a file makes (PR1 of r22b) */
type Replaying = Replay & { refused: Refuse; waits: (sql: Sql) => Promise<void> }

/** A statement of `name`: its type and node, as nodeOf reads its parse tree, and what Atlas sends */
type Sent = { name: string; node: Record<string, unknown>; sent: string; type: string }

/** `sent` run on the replay's connection, as it is or in pg_default, reported when it ran in pg_default */
async function runSent(run: Run, { name, node, sent, type }: Sent, replay: Replaying): Promise<void> {
	const moved = inDefault(run.tablespaces, sent, { [type]: node })
	await run.sql.unsafe(moved?.sql ?? sent, [])
	if (moved !== undefined) replay.movedTo?.(name, sent, moved.names)
}

/** `statement` run on the replay's connection, a statement on roles as the replay runs it (pg-replay-made.ts) */
async function runStatement(run: Run, statement: Sent, replay: Replaying): Promise<void> {
	const { name, sent, type } = statement
	try {
		const bare = runRole(run, statement)
		if (bare === undefined) await runSent(run, statement, replay)
		else if (await bare) replay.madeBare?.(name, sent)
	} catch (error) {
		throw replay.refused(`${name}: devUrl refused ${JSON.stringify(sent)} as ${replay.doing}`, error)
	}
	/* an extension devUrl's database holds that requires the one just made follows it, as on the target */
	if (type === "CreateExtensionStmt") await replay.waits(run.sql)
}

export { type Refuse, type Replay, type Replaying, runStatement }
