/** A migrate diff's project and the Atlas and drizzle-kit it drives, shared by the diff tests */
import { readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Run, RunResult } from "../../migrate/core/process.ts"
import { ok } from "./io.ts"

/** A project a diff runs in, made by `project`: its drizzle config written, as migrate init writes one */
export function diffProject(project: () => string): string {
	const dir = project()
	writeFileSync(join(dir, "drizzle.config.ts"), 'export default { dialect: "sqlite" }\n')
	return dir
}

export const dirArg = (args: readonly string[]) => (args[args.indexOf("--dir") + 1] as string).replace("file://", "")

/**
 * Atlas as the migrate commands drive it: `migrate hash` writes atlas.sum from the directory's
 * files, `migrate diff` hands the directory it replays to `diff`; drizzle-kit exports SCHEMA.
 */
export function fakeAtlas(diff: (dir: string) => RunResult | undefined | void): Run & { calls: string[][] } {
	const calls: string[][] = []
	const run: Run = (cmd, args) => {
		calls.push([cmd, ...args])
		if (cmd === process.execPath) return ok("CREATE TABLE post (id TEXT PRIMARY KEY);")
		if (args[0] === "version") return ok("atlas version v1.3.0")
		const dir = dirArg(args)
		if (args[1] === "hash") {
			writeFileSync(
				join(dir, "atlas.sum"),
				readdirSync(dir)
					.filter((f) => f.endsWith(".sql"))
					.sort()
					.join("\n"),
			)
			return ok()
		}
		return diff(dir) ?? ok()
	}
	return Object.assign(run, { calls })
}
