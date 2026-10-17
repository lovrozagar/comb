import { defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: "unit",
					include: [
						"src/**/*.test.ts",
						"lint/**/*.test.ts",
						"tests/structure/**/*.test.ts",
						/* transitional: the suites still under tests/unit until they move beside their source */
						"tests/unit/**/*.test.ts",
						"tests/e2e/**/*.test.ts",
					],
				},
			},
			{
				test: {
					name: "integration",
					include: ["tests/integration/**/*.test.ts"],
					testTimeout: 60_000,
					hookTimeout: 60_000,
				},
			},
		],
		coverage: {
			include: ["src/**", "lint/**"],
			exclude: ["**/*.test.ts", "**/__fixtures__/**", "**/index.ts"],
			provider: "v8",
			reporter: ["text", "json-summary"],
			/*
			 * A ratchet, not a target. These are the numbers the suite reaches
			 * today; they exist so coverage cannot quietly slide backwards when
			 * code is added without tests. Raise them when you raise coverage —
			 * never lower them to make a build pass.
			 *
			 * The floor is deliberately global rather than 100%: `cli.ts` and the
			 * migrate drivers shell out to wrangler, atlas and drizzle-kit, and
			 * unit-testing those means asserting against mocks of tools whose
			 * output we do not control. Pure, exported code sits at ~94%.
			 */
			thresholds: {
				branches: 75,
				functions: 83,
				lines: 84,
				statements: 83,
			},
		},
	},
})
