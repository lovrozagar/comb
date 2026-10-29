/**
 * What a `c` helper records on the column it builds, for codegen to read at runtime: the helper's
 * kind and the very values it was given. Kept under a registered symbol on drizzle's builder
 * config, which the built column keeps, so a second copy of comb reads what the first wrote.
 */

/** The `c` helpers, by name */
type CombColumnKind =
	| "boolean"
	| "createdAt"
	| "deletedAt"
	| "enum"
	| "id"
	| "integer"
	| "json"
	| "real"
	| "ref"
	| "serialId"
	| "text"
	| "timestamp"
	| "updatedAt"

/** A column's comb metadata: its helper, and the constraints, enum values, states, schema or prefix it took */
type CombColumnMeta = {
	constraints?: Readonly<Record<string, unknown>>
	kind: CombColumnKind
	prefix?: string
	schema?: unknown
	states?: unknown
	values?: readonly string[]
}

const COMB_COLUMN: unique symbol = /* @__PURE__ */ Symbol.for("comb.column")

/** `builder` with `meta` recorded on its config; the options a helper was not given are left out */
function withCombColumn<B>(builder: B, meta: { [K in keyof CombColumnMeta]: CombColumnMeta[K] | undefined }): B {
	const recorded = Object.fromEntries(Object.entries(meta).filter(([, value]) => value !== undefined))
	;(builder as unknown as { config: Record<symbol, unknown> }).config[COMB_COLUMN] = recorded
	return builder
}

/** The comb metadata a built column (or its builder) carries; undefined for a column no `c` helper built */
function combColumnMeta(column: unknown): CombColumnMeta | undefined {
	const config = (column as { config?: Record<symbol, unknown> } | null | undefined)?.config
	return config?.[COMB_COLUMN] as CombColumnMeta | undefined
}

/** A c.enum's options as its column's record: the flags its constraints, the rest its state machine, none when it names no state (F9) */
function enumMeta(
	values: readonly string[],
	options: { nomutate?: boolean | undefined; private?: boolean | undefined; tenant?: boolean | undefined } = {},
): { [K in keyof CombColumnMeta]: CombColumnMeta[K] | undefined } {
	const { nomutate, private: hidden, tenant, ...states } = options
	const flags = { nomutate, private: hidden, tenant }
	const flagged = Object.values(flags).some((flag) => flag !== undefined)
	return {
		constraints: flagged ? flags : undefined,
		kind: "enum",
		/* a machine given alone is kept as the very object passed, as assertTransition takes it too */
		states: Object.keys(states).length === 0 ? undefined : flagged ? states : options,
		values,
	}
}

export { combColumnMeta, enumMeta, withCombColumn, type CombColumnKind, type CombColumnMeta }
