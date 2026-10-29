/** The shape of a Postgres baseline's catalog read (pg-live-objects.ts), apart so the CLI's io names it without its code. */

/**
 * What a database holds of what Atlas OSS will not compare: each routine by name, its kind and each
 * overload's signature (its input argument types); each table's triggers by name, with when and for
 * what they fire (tgtype) and whether they do (P13)
 */
export type LiveObjects = {
	routines: Map<string, { kind: "function" | "procedure"; signatures: Set<string> }>
	triggers: Map<string, Map<string, { enabled: boolean; type: number }>>
}

/** The database a read reaches, and the schema it reads */
export type LiveTarget = { schema: string; url: string }

/** How a baseline reads them: postgres.js, unless a test fakes it */
export type LiveRead = (target: LiveTarget) => Promise<LiveObjects>
