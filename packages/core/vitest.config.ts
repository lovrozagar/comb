import { defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts"],
		/* tests/bun holds the bun:sqlite / bun:test suites — `bun run test:bun`. */
		exclude: ["tests/bun/**", "node_modules/**"],
		coverage: {
			include: ["src/**"],
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
