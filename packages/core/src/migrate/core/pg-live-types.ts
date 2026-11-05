/** The shape of a Postgres baseline's catalog read (pg-live-objects.ts), apart so the CLI's io names it without its code. */

/**
 * What a database holds of what Atlas OSS will not compare: each routine by name, its kind and each
 * overload's signature (its input argument types); each table's triggers by name, with when and for
 * what they fire (tgtype) and whether they do; its views, materialized views, sequences and
 * policies by name
 */
export type LiveObjects = {
	/** each extension, by name, but plpgsql */
	extensions: Set<string>
	/** each domain, composite and range type and collation, by name, with what it is */
	kinds: Map<string, "collation" | "composite type" | "domain" | "range type">
	/**
	 * what the read names by one label each, in the target schema: `aggregate f(int4)`,
	 * `function f(int4) security definer`, `operator @@(none, int4)`, `cast (pair as int4)`, `view v
	 * (security_invoker=true)`, `index i on m`, `replica identity on t (full)`
	 */
	others: Set<string>
	/** what the read names database-wide, which a platform may hold of its own: `event trigger e`, `publication p` */
	platform: Set<string>
	/** each table's policies, by name, with their command, roles and kind: `for all, to public, permissive` */
	policies: Map<string, Map<string, string>>
	/** each view, materialized view and sequence no column owns, by name, with what it is */
	relations: Map<string, "materialized view" | "sequence" | "view">
	/** each table's row level security where it is on: `enabled, not forced` */
	rls: Map<string, string>
	routines: Map<string, { kind: "function" | "procedure"; signatures: Set<string> }>
	/** each table's rules, by name, but a view's own */
	rules: Map<string, Set<string>>
	/** each sequence's settings: `start 1, increment 1, min 1, max …, no cycle` */
	sequences: Map<string, string>
	triggers: Map<string, Map<string, { enabled: boolean; type: number }>>
	/** the role the read connects as: the one the migrations ran as, which CURRENT_USER names in a policy */
	user: string
}

/** The database a read reaches, and the schema it reads */
export type LiveTarget = { schema: string; url: string }

/** How a baseline reads them: postgres.js, unless a test fakes it */
export type LiveRead = (target: LiveTarget) => Promise<LiveObjects>
