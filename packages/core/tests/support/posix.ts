/**
 * The suites CI runs on macOS as well as Linux (plan 14's 4.19), where macOS breaks what Linux
 * does not: real processes and real paths (a tmpdir under /var that is /private/var, a
 * case-insensitive APFS, BSD tools). Codegen's loader, which runs its child in a process group of
 * its own and signals it and times it out (F43); codegen's CLI suites on real projects; and the CLI
 * and migrate commands, which shell out through migrate/core/process.ts, with the SQLite family's
 * migrate suites on real Atlas. macOS's runners have no Postgres, so a suite that needs one is
 * left out; every suite here runs on Linux too.
 */
export const POSIX_UNIT: string[] = [
	"src/cli/**/*.test.ts",
	"src/codegen/runtime/**/*.test.ts",
	"src/migrate/core/process.test.ts",
	"tests/structure/codegen-loads-in-child.test.ts",
]

export const POSIX_INTEGRATION: string[] = [
	"tests/integration/codegen/**/*.test.ts",
	"tests/integration/d1/migrate-cli.test.ts",
	"tests/integration/libsql/migrate-cli.test.ts",
	"tests/integration/sqlite/atlas-*.test.ts",
	"tests/integration/sqlite/own-output.test.ts",
	"tests/integration/sqlite/rebuild-copy.test.ts",
]

/* the codegen suites that read from a Postgres server */
export const POSIX_EXCLUDE: string[] = ["tests/integration/codegen/pg-*.test.ts"]
