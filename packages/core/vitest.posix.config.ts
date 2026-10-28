import { defineConfig } from "vitest/config"
import { POSIX_SUITES } from "./tests/support/posix.ts"

/* every test run is in UTC, as CI's runners are, so a local stamp vouches for what CI sees; the
   workers forked after this file is read inherit it (tests/structure/workflows.test.ts holds it) */
process.env.TZ = "UTC"

/* The suites CI runs on macOS too (tests/support/posix.ts), as the unit project runs them on Linux. */
export default defineConfig({
	test: {
		include: POSIX_SUITES,
		setupFiles: ["tests/support/pg-parser.setup.ts"],
		testTimeout: 30_000,
	},
})
