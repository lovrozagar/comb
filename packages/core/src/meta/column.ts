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

export { combColumnMeta, withCombColumn, type CombColumnKind, type CombColumnMeta }
