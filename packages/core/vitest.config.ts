import { configDefaults, defineConfig } from "vitest/config"
import { LOAD_TIMEOUT_MS } from "./src/codegen/runtime/load.ts"
import { OFF_UTC_INTEGRATION, OFF_UTC_POSTGRES, OFF_UTC_UNIT, OFF_UTC_ZONE } from "./tests/support/off-utc.ts"
import { PG_INTEGRATION } from "./tests/support/pg-suites.ts"
import { MAX_WORKERS } from "./tests/support/workers.ts"

/* every test run is in UTC, as CI's runners are, so a local stamp vouches for what CI sees; the
   workers forked after this file is read inherit it (tests/structure/workflows.test.ts holds it) */
process.env.TZ = "UTC"

/*
 * A codegen test loads its tables in codegen's own child process, up to three times in one test
 * (analyzer.test.ts, codegen.test.ts's F12), each bounded by codegen itself: LOAD_TIMEOUT_MS, and
 * the supervisor's 10 s grace past it. A budget below that fails a test on the machine's load, not
 * on what codegen does: F12 takes 3.7 s alone and passed 30 s at load 43 (runs/798b98a-p55-gates-
 * 20261101T220155Z). With this one, a slow load ends in codegen's own error, which the test reads.
 */
const CODEGEN_BUDGET_MS = 3 * (LOAD_TIMEOUT_MS + 10_000)

export default defineConfig({
	test: {
		maxWorkers: MAX_WORKERS,
		projects: [
			{
				test: {
					name: "unit",
					include: ["src/**/*.test.ts", "lint/**/*.test.ts", "tests/structure/**/*.test.ts"],
					setupFiles: ["tests/support/pg-parser.setup.ts"],
					testTimeout: CODEGEN_BUDGET_MS,
				},
			},
			{
				test: {
					name: "integration",
					include: ["tests/integration/**/*.test.ts"],
					exclude: [...configDefaults.exclude, ...PG_INTEGRATION],
					globalSetup: ["tests/integration/support/global-setup.ts"],
					testTimeout: CODEGEN_BUDGET_MS,
					hookTimeout: 60_000,
				},
			},
			/* the suites on the shared Postgres test server, one run at a time on it (tests/support/pg-suites.ts) */
			{
				test: {
					name: "postgres",
					include: PG_INTEGRATION,
					globalSetup: ["tests/integration/support/pg-run-lock.ts", "tests/integration/support/pg-sweeps.ts"],
					setupFiles: ["tests/support/server-lock.setup.ts"],
					testTimeout: CODEGEN_BUDGET_MS,
					hookTimeout: 60_000,
				},
			},
			/* the suites that page or read Date keys, once more far from UTC (tests/support/off-utc.ts) */
			{
				test: {
					env: { TZ: OFF_UTC_ZONE },
					include: OFF_UTC_UNIT,
					name: `unit (${OFF_UTC_ZONE})`,
					setupFiles: ["tests/support/pg-parser.setup.ts"],
					testTimeout: 30_000,
				},
			},
			{
				test: {
					env: { TZ: OFF_UTC_ZONE },
					globalSetup: ["tests/integration/support/global-setup.ts"],
					hookTimeout: 60_000,
					include: OFF_UTC_INTEGRATION,
					name: `integration (${OFF_UTC_ZONE})`,
					testTimeout: 60_000,
				},
			},
			{
				test: {
					env: { TZ: OFF_UTC_ZONE },
					globalSetup: ["tests/integration/support/pg-run-lock.ts", "tests/integration/support/pg-sweeps.ts"],
					setupFiles: ["tests/support/server-lock.setup.ts"],
					hookTimeout: 60_000,
					include: OFF_UTC_POSTGRES,
					name: `postgres (${OFF_UTC_ZONE})`,
					testTimeout: 60_000,
				},
			},
		],
		coverage: {
			include: ["src/**", "lint/**"],
			/* src/bin.ts is the three-line shim over runCli; it only runs as a process, which v8 does not see */
			exclude: ["**/*.test.ts", "**/__fixtures__/**", "**/index.ts", "src/bin.ts"],
			provider: "v8",
			reporter: ["text", "json-summary"],
			/*
			 * Every file at 100%, each on its own. The exclusions above are the only exemptions;
			 * packages/core/docs/testing.md says why each holds. Shell-outs to atlas, wrangler and
			 * drizzle-kit go through migrate/core/process.ts, so the code around them is tested
			 * with a fake runner and the real tools run in the integration suites.
			 */
			thresholds: {
				perFile: true,
				branches: 100,
				functions: 100,
				lines: 100,
				statements: 100,
			},
		},
	},
})
