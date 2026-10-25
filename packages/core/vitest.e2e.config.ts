import { defineConfig } from "vitest/config"

/* every test run is in UTC, as CI's runners are, so a local stamp vouches for what CI sees; the
   workers forked after this file is read inherit it (tests/structure/workflows.test.ts holds it) */
process.env.TZ = "UTC"

/* The e2e suites: the comb binary on scratch apps, real Atlas, libsql and wrangler --local. */
export default defineConfig({
	test: {
		fileParallelism: false,
		hookTimeout: 240_000,
		include: ["tests/e2e/**/*.e2e.test.ts"],
		testTimeout: 240_000,
	},
})
