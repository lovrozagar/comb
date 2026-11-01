import type { LiveObjects } from "../core/pg-live-types.ts"

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
