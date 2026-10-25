import { defineConfig } from "vitest/config"

/* every test run is in UTC, as CI's runners are, so a local stamp vouches for what CI sees; the
   workers forked after this file is read inherit it (tests/structure/workflows.test.ts holds it) */
process.env.TZ = "UTC"

/* The consumer cells: the packed tarball installed from the npm registry into fresh projects, so
 * they need the network and stay out of `test`. `bun run test:consumers` runs them, a `verify`
 * gate; CI runs them in the `consumers` job. Every cell is a full install, so files run one at a
 * time. */
export default defineConfig({
	test: {
		fileParallelism: false,
		hookTimeout: 900_000,
		include: ["tests/consumers/**/*.consumer.test.ts"],
		reporters: ["verbose"],
		testTimeout: 600_000,
	},
})
