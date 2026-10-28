import { defineConfig } from "vitest/config"
import { POSIX_EXCLUDE, POSIX_INTEGRATION, POSIX_UNIT } from "./tests/support/posix.ts"

/* every test run is in UTC, as CI's runners are, so a local stamp vouches for what CI sees; the
   workers forked after this file is read inherit it (tests/structure/workflows.test.ts holds it) */
process.env.TZ = "UTC"

/* The suites CI runs on macOS too (tests/support/posix.ts), as vitest.config.ts runs them on Linux. */
export default defineConfig({
	test: {
		projects: [
			{
				test: {
					include: POSIX_UNIT,
					name: "unit",
					setupFiles: ["tests/support/pg-parser.setup.ts"],
					testTimeout: 30_000,
				},
			},
			{
				test: {
					exclude: POSIX_EXCLUDE,
					globalSetup: ["tests/integration/support/posix-setup.ts"],
					hookTimeout: 60_000,
					include: POSIX_INTEGRATION,
					name: "integration",
					testTimeout: 60_000,
				},
			},
		],
	},
})
