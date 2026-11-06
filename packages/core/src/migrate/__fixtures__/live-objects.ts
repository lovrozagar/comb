import type { LiveObjects, LiveRead } from "../core/pg-live-types.ts"
import type { replayCatalog } from "../core/pg-replay.ts"

/** The database name a faked replay hands Atlas to read */
export const FAKE_REPLAY = "comb_replay_fake"

/**
 * comb's replay of the history on dev, faked: it leaves what `read` finds, the role the target is
 * read as standing for its own, and hands `inspect` its database as the real replay does
 */
export const replaying =
	(read: LiveRead): typeof replayCatalog =>
	async (target, { inspect, targetUser }) => ({
		catalog: { ...(await read(target)), user: targetUser },
		inspected: await inspect(FAKE_REPLAY),
	})

/** A catalog read that found nothing, for a test to spread what it found over */
export const noLive = (): LiveObjects => ({
	extensions: new Set(),
	kinds: new Map(),
	others: new Set(),
	platform: new Set(),
	policies: new Map(),
	relations: new Map(),
	rls: new Map(),
	routines: new Map(),
	rules: new Map(),
	sequences: new Map(),
	triggers: new Map(),
	user: "app",
})

/** A database holding `relations`, by name and what each is, a sequence as CREATE SEQUENCE leaves it */
export const holdingRelations = (
	...relations: Array<[string, "materialized view" | "sequence" | "view"]>
): LiveObjects => ({
	...noLive(),
	relations: new Map(relations),
	sequences: new Map(
		relations
			.filter(([, kind]) => kind === "sequence")
			.map(([name]) => [name, "start 1, increment 1, min 1, max 9223372036854775807, no cycle"]),
	),
})
