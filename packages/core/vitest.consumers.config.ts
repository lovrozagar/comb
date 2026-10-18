import { defineConfig } from "vitest/config"

/* The consumer cells: the packed tarball installed from the npm registry into fresh projects, so
 * they need the network and stay out of `test` and `verify`. `bun run test:consumers` runs them;
 * CI runs them in the `consumers` job. Every cell is a full install, so files run one at a time. */
export default defineConfig({
	test: {
		fileParallelism: false,
		hookTimeout: 900_000,
		include: ["tests/consumers/**/*.consumer.test.ts"],
		reporters: ["verbose"],
		testTimeout: 600_000,
	},
})
