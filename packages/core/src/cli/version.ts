/**
 * comb's version for `comb --version`, read from its package.json beside `moduleUrl` (comb's own)
 * by a path: no global URL, which a project with Workers' types and Node's but no DOM gives
 * Workers' type of. A Bun single-file executable embeds no package.json, so the read is
 * refused there with why; a JSON import would embed it, but
 * needs resolveJsonModule in every consumer that compiles comb's source.
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { refuseCompiled } from "../migrate/core/compiled.ts"

/** comb's version, from the package.json two folders above `moduleUrl` */
export function version(moduleUrl: string = import.meta.url): string {
	refuseCompiled(
		moduleUrl,
		"comb --version reads comb's package.json from disk, which a Bun single-file executable does not hold: run comb with bun or node",
	)
	const manifest = join(dirname(fileURLToPath(moduleUrl)), "../../package.json")
	return (JSON.parse(readFileSync(manifest, "utf8")) as { version: string }).version
}
