/**
 * Type-safe column constraint definitions
 * These exist only in the type system and are completely erased at runtime
 */

/* Base constraints shared across column types */
type BaseConstraints = {
	/** Field is auto-generated, optional in create, excluded from update */
	autogenerate?: boolean
	/** Field cannot be mutated after creation */
	nomutate?: boolean
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
	initial?: TState
	/** Values from which no transition is legal */
	terminal?: readonly TState[]
	/** Legal moves, `from` → `to[]`. Omitted states are unconstrained. */
	transitions?: Partial<Record<TState, readonly TState[]>>
}
