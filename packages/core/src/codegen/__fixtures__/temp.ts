/**
 * Where a codegen test writes its tables files: inside the package (gitignored), so their imports
 * of drizzle, zod and comb resolve as an installed app's would when the runtime reader loads them
 */
import fs from "node:fs"
import path from "node:path"

/** The directory test fixtures are made in, created when first asked for */
export function fixtureRoot(): string {
	const root = path.join(import.meta.dirname, "../../../.tmp-unit")
	fs.mkdirSync(root, { recursive: true })
	return root
}
