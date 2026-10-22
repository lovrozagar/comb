/**
 * Type-safe column constraint definitions
 * These exist only in the type system and are completely erased at runtime
 */

/* Base constraints shared across column types */
type BaseConstraints = {
	/** Field is filled by comb or the database: generated create and update DTOs leave it out */
	autogenerate?: boolean
	/**
	 * A foreign key that may move after creation (a person to another team): generated update DTOs
	 * take it. Every other reference is set once, at creation. Refused on a column that references
	 * nothing, and together with `nomutate`.
	 */
	mutable?: boolean
	/** Field cannot be mutated after creation */
	nomutate?: boolean
	/** Field is never read back: generated read DTOs, the meta stamp and the manifest leave it out */
	private?: boolean
	/**
	 * This column scopes rows to a tenant.
	 *
	 * Declared, never inferred: comb can see that a column is a foreign key but
	 * not that the table it points at is the tenant, and a wrong tenant boundary
	 * is worse than a missing one. Saying so here makes it a hand-reviewed fact.
	 * At most one column per table may carry it.
	 */
	tenant?: boolean
}

/* String transformation constraints */
type StringTransformConstraints = {
	/** Apply lowercase transformation */
	lowercase?: boolean
	/** Trim whitespace */
	trim?: boolean
	/** Apply uppercase transformation */
	uppercase?: boolean
}

/* Numeric range constraints */
type NumericRangeConstraints = {
	/** Maximum value */
	max?: number
	/** Minimum value */
	min?: number
}

/* String validation constraints */
type StringValidationConstraints = {
	/** Email validation */
	email?: boolean
	/** Image URI validation (accepts https URLs and data:image/ URIs) */
	imageUri?: boolean
	/** Human/entity name validation (letters, marks, numbers, spaces, punctuation) */
	name?: boolean
	/** Password validation (min 8, max 72, printable ASCII) */
	password?: boolean
	/** Regex pattern validation */
	pattern?: string
	/** URL validation */
	url?: boolean
}

/**
 * Text column constraints
 * Closed record - only these properties allowed
 */
export type TextConstraints = BaseConstraints &
	StringTransformConstraints &
	NumericRangeConstraints &
	StringValidationConstraints

/**
 * Integer/numeric column constraints
 * Closed record - only these properties allowed
 */
export type IntegerConstraints = BaseConstraints & NumericRangeConstraints

/**
 * JSON column constraints
 * Closed record - only these properties allowed
 */
export type JsonConstraints = BaseConstraints & {
	/** Maximum JSON stringified byte length */
	maxBytes?: number
}

/**
 * Timestamp column constraints
 * Closed record - only these properties allowed
 */
export type TimestampConstraints = BaseConstraints

/**
 * State machine declared alongside an enum column's values.
 *
 * Type-level only, like every other constraint here — the analyzer reads it
 * out of the source. Hold the same object as a const and pass it to both
 * `c.enum` and `assertTransition`. See docs/state-machines.md.
 */
export type EnumStates<TState extends string = string> = {
	/** The value a row starts at */
	initial?: TState | undefined
	/** Values from which no transition is legal */
	terminal?: readonly TState[] | undefined
	/** Legal moves, `from` → `to[]`. Omitted states are unconstrained. */
	transitions?: Readonly<Partial<Record<TState, readonly TState[]>>> | undefined
}
