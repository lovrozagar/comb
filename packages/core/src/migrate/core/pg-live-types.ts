/** The shape of a Postgres baseline's catalog read (pg-live-objects.ts), apart so the CLI's io names it without its code. */

/**
 * What a database holds of what Atlas OSS will not compare: each routine by name, its kind and each
 * overload's signature (its input argument types); each table's triggers by name, with when and for
 * what they fire (tgtype) and whether they do (P13); its views, materialized views, sequences and
 * policies by name
 */
export type LiveObjects = {
	/** each table's policies, by name (P9 of the 0.15.0 review) */
	policies: Map<string, Set<string>>
	/** each view, materialized view and sequence no column owns, by name, with what it is (P9) */
	relations: Map<string, "materialized view" | "sequence" | "view">
	routines: Map<string, { kind: "function" | "procedure"; signatures: Set<string> }>
	triggers: Map<string, Map<string, { enabled: boolean; type: number }>>
}

/** The database a read reaches, and the schema it reads */
export type LiveTarget = { schema: string; url: string }

/** How a baseline reads them: postgres.js, unless a test fakes it */
export type LiveRead = (target: LiveTarget) => Promise<LiveObjects>
