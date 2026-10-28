/** The shape of a Postgres baseline's catalog read (pg-live-objects.ts), apart so the CLI's io names it without its code. */

/** What a database holds of what Atlas OSS will not compare: each routine's kind by name, and each table's triggers */
export type LiveObjects = { routines: Map<string, "function" | "procedure">; triggers: Map<string, Set<string>> }

/** The database a read reaches, and the schema it reads */
export type LiveTarget = { schema: string; url: string }

/** How a baseline reads them: postgres.js, unless a test fakes it */
export type LiveRead = (target: LiveTarget) => Promise<LiveObjects>
