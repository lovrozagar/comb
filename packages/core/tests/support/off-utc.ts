/**
 * Every run is in UTC, as CI's runners are (vitest.config.ts), which hides a bug that shows only off
 * UTC. comb has code that reads time in the process's zone: node-postgres's local-midnight Date for
 * an infinite `timestamp`, and Date reads of both timestamp modes. So the suites that page or read
 * Date keys run once more in a zone far from UTC with a fractional offset, as vitest projects of
 * their own: a pass or a failure, the same files (tests/structure/workflows.test.ts holds the list).
 */

/** The zone of the extra pass: UTC+05:45, a quarter-hour offset no whole-hour rounding hides */
export const OFF_UTC_ZONE = "Asia/Kathmandu"

/** What makes a suite one of them: a Date key, a timestamp mode, or the shared seconds-mode cases */
export const DATE_KEYS =
	/mode: "timestamp"|timestamp\(|new Date\(|getTimezoneOffset|secondsBound|timestampBound|seconds-anchor/

/** The unit suites that page, read or write Date keys */
export const OFF_UTC_UNIT = [
	"src/codegen/generators/diagrams.test.ts",
	"src/codegen/generators/dtos/example-meta.test.ts",
	"src/codegen/generators/dtos/field-schema.test.ts",
	"src/codegen/generators/dtos/generate.fields.test.ts",
	"src/migrate/core/atlas-dir.test.ts",
	"src/migrate/core/classify.test.ts",
	"src/migrate/drivers/d1.test.ts",
	"src/pg/columns.meta.test.ts",
	"src/pg/columns.test.ts",
	"src/query/cursor-precision.test.ts",
	"src/query/cursor-ref.test.ts",
	"src/query/cursor.test.ts",
	"src/query/drizzle.test.ts",
	"src/query/keyset-budget.test.ts",
	"src/query/sqlite/build-list-query.derived.test.ts",
	"src/query/sqlite/build-list-query.test.ts",
	"src/query/sqlite/cursor-fit.test.ts",
	"src/query/sqlite/cursor-where.test.ts",
	"src/query/sqlite/executor.test.ts",
	"src/sqlite/columns.meta.test.ts",
	"src/sqlite/columns.test.ts",
]

/** The integration suites that page or read Date keys */
export const OFF_UTC_INTEGRATION = [
	"tests/integration/codegen/dtos-timestamps.test.ts",
	"tests/integration/d1/list-query-nonfinite.test.ts",
	"tests/integration/libsql/date-filter.test.ts",
	"tests/integration/postgres/columns.test.ts",
	"tests/integration/postgres/keyset-infinity-date.test.ts",
	"tests/integration/postgres/keyset-nonfinite.test.ts",
	"tests/integration/postgres/keyset.test.ts",
	"tests/integration/sqlite/list-query-filters.test.ts",
	"tests/integration/sqlite/list-query-seconds.test.ts",
]
