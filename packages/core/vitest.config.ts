import { defineConfig } from "vitest/config"

/* every test run is in UTC, as CI's runners are, so a local stamp vouches for what CI sees; the
   workers forked after this file is read inherit it (tests/structure/workflows.test.ts holds it) */
process.env.TZ = "UTC"

export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: "unit",
					include: ["src/**/*.test.ts", "lint/**/*.test.ts", "tests/structure/**/*.test.ts"],
					setupFiles: ["tests/support/pg-parser.setup.ts"],
					/* a codegen test loads its tables in codegen's own child process, a fraction of a second each */
					testTimeout: 30_000,
				},
			},
			{
				test: {
					name: "integration",
					include: ["tests/integration/**/*.test.ts"],
					globalSetup: ["tests/integration/support/global-setup.ts"],
					testTimeout: 60_000,
					hookTimeout: 60_000,
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
