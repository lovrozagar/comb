/**
 * The suites CI runs on macOS as well as Linux (plan 14's 4.19): codegen's loader, which runs its
 * child in a process group of its own and signals it and times it out (F43), and the CLI and
 * migrate commands, which shell out through migrate/core/process.ts. Each is a unit suite, so
 * Linux runs it in `test` too; macOS's runners have no Postgres, which the integration suites need.
 */
export const POSIX_SUITES: string[] = [
	"src/cli/**/*.test.ts",
	"src/codegen/runtime/**/*.test.ts",
	"src/migrate/core/process.test.ts",
	"tests/structure/codegen-loads-in-child.test.ts",
]
