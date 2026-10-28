/* The posix run's global setup (vitest.posix.config.ts): its suites shell out to Atlas, which it
 * requires as global-setup.ts does, and none reads from Postgres, which macOS's runners lack. */
import { requireAtlas } from "./atlas.ts"

export default function setup(): void {
	requireAtlas()
}
