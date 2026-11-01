/**
 * What neither Atlas's table diff nor comb's catalog read compares (P12 of r19), the one list the
 * every-run warning is written from: a kind either has its arm in pg-live-catalog.ts, is Atlas's (a
 * table, its columns, indexes, constraints, enum values, storage parameters), or is named here
 */
const NOT_COMPARED = [
	"views' and policies' queries and checks",
	"triggers' WHEN clauses",
	"view columns' defaults",
	"columns' statistics targets",
	"statistics objects",
	"text search configurations and dictionaries",
	"foreign data wrappers, servers and user mappings",
	"grants",
	"comments",
] as const

/** `kinds` as one sentence of the warning */
const sentence = (kinds: readonly string[]): string =>
	`Warning: ${kinds.slice(0, -1).join(", ")} and ${kinds.at(-1) as string} are not compared`

/** What neither Atlas nor comb compares, which a baseline says every time */
const UNCOMPARED: string = /* @__PURE__ */ sentence(NOT_COMPARED)

export { NOT_COMPARED, UNCOMPARED }
