import { defineConfig } from "vitest/config"

/* The e2e suites: the comb binary on scratch apps, real Atlas, libsql and wrangler --local. */
export default defineConfig({
	test: {
		fileParallelism: false,
		hookTimeout: 240_000,
		include: ["tests/e2e/**/*.e2e.test.ts"],
		testTimeout: 240_000,
	},
})
