import { defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: "unit",
					include: ["src/**/*.test.ts", "lint/**/*.test.ts", "tests/structure/**/*.test.ts"],
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
			 * A ratchet, not a target. These are the numbers the suite reaches
			 * today; they exist so coverage cannot quietly slide backwards when
			 * code is added without tests. Raise them when you raise coverage —
			 * never lower them to make a build pass.
			 *
			 * The floor is global until every file reaches 100%. Shell-outs to
			 * atlas, wrangler and drizzle-kit go through migrate/core/process.ts,
			 * so the code around them is tested with a fake runner.
			 */
			thresholds: {
				branches: 81,
				functions: 91,
				lines: 90,
				statements: 89,
			},
		},
	},
})
