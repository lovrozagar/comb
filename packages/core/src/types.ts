/** Database-relevant HTTP status keys */
export type StatusKey =
	| "bad_request"
	| "conflict"
	| "forbidden"
	| "internal_server_error"
	| "service_unavailable"
	| "unprocessable_entity"

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
	CURSOR_PAGINATION_UNSUPPORTED: "cursor_pagination_unsupported",
	DATABASE_IO_ERROR: "database_io_error",
	DATABASE_READONLY: "database_readonly",
	DATABASE_UNAVAILABLE: "database_unavailable",
	FILTER_NOT_WIRED: "filter_not_wired",
	FOREIGN_KEY_VIOLATION: "foreign_key_violation",
	INVALID_CURSOR: "invalid_cursor",
	INVALID_SELECT: "invalid_select",
	INVALID_STATE_TRANSITION: "invalid_state_transition",
	INVALID_VALUE: "invalid_value",
	PRIMARY_KEY_VIOLATION: "primary_key_violation",
	REQUIRED_FIELD_MISSING: "required_field_missing",
	SEARCH_NOT_WIRED: "search_not_wired",
	SHARDS_FULL: "shards_full",
	SORT_NOT_WIRED: "sort_not_wired",
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
