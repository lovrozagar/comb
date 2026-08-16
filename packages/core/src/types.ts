/** Database-relevant HTTP status keys */
export type StatusKey =
	| "bad_request"
	| "conflict"
	| "forbidden"
	| "internal_server_error"
	| "service_unavailable"
	| "unprocessable_entity"

// oxlint-disable-next-line typescript/no-explicit-any
export const EMPTY_OBJ = Object.freeze(Object.create(null)) as Record<string, any>
// oxlint-disable-next-line typescript/no-explicit-any
export const EMPTY_ARR = Object.freeze([]) as readonly any[]

export const statusKeyToCode: Record<StatusKey, number> = {
	bad_request: 400,
	conflict: 409,
	forbidden: 403,
	internal_server_error: 500,
	service_unavailable: 503,
	unprocessable_entity: 422,
}

/** Database-related error key constants */
export const combErrorKeys = {
	CHECK_CONSTRAINT_VIOLATION: "check_constraint_violation",
	DATABASE_IO_ERROR: "database_io_error",
	DATABASE_READONLY: "database_readonly",
	DATABASE_UNAVAILABLE: "database_unavailable",
	FOREIGN_KEY_VIOLATION: "foreign_key_violation",
	PRIMARY_KEY_VIOLATION: "primary_key_violation",
	REQUIRED_FIELD_MISSING: "required_field_missing",
	STORAGE_LIMIT_REACHED: "tier_database_limit_reached",
	UNIQUE_CONSTRAINT_VIOLATION: "unique_constraint_violation",
} as const

/** Lowercase error key values from combErrorKeys */
export type CombErrorKey = (typeof combErrorKeys)[keyof typeof combErrorKeys]

/** Constraint map entry for mapping DB constraint violations to domain errors */
export type ConstraintMapEntry = {
	cause: string
	errorKey: string
	statusKey?: "bad_request" | "conflict" | "forbidden"
}

/** Per-table constraint violation mappings */
export type ConstraintMap = {
	[table: string]: {
		check?: Record<string, ConstraintMapEntry>
		foreignKey?: Record<string, ConstraintMapEntry>
		primaryKey?: ConstraintMapEntry
		unique?: Record<string, ConstraintMapEntry>
	}
}

/** Function signature for database error handlers */
export type DatabaseErrorHandler = (error: unknown, constraintMaps: ConstraintMap[]) => void
