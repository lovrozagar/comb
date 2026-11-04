/**
 * The integration suites that reach the shared Postgres test server, which run in vitest.config.ts's
 * Postgres projects, under the run's lock (tests/integration/support/pg-run-lock.ts): every suite of
 * tests/integration/postgres, and each suite elsewhere that reaches the server through the Postgres
 * test helpers or COMB_TEST_PG_URL. tests/structure/workflows.test.ts finds them by their own text, so
 * a new one cannot run outside the lock.
 */

/** What makes a suite outside tests/integration/postgres one of them */
export const PG_REACH =
	/support\/(?:pg|pg-check|pg-lock|pg-pause|pg-roles|pg-run-lock|pg-url|stale-replay)\.ts"|COMB_TEST_PG_URL/

/** The suites, by directory and by name */
export const PG_INTEGRATION = [
	"tests/integration/postgres/**/*.test.ts",
	"tests/integration/codegen/json-stored-document.test.ts",
	"tests/integration/codegen/pg-arrays.test.ts",
	"tests/integration/codegen/pg-ip.test.ts",
	"tests/integration/codegen/pg-plain-json.test.ts",
	"tests/integration/codegen/pg-schemas.test.ts",
	"tests/integration/codegen/pg-types.test.ts",
	"tests/integration/codegen/pg-typmods.test.ts",
	"tests/integration/codegen/pg-unique-names.test.ts",
	"tests/integration/sqlite/constraint-map-keys.test.ts",
]
