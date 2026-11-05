/* The repository README, and its sections, for the structure tests that hold what it says */
import { readFileSync } from "node:fs"
import { join } from "node:path"

/** The repository README */
export const README: string = readFileSync(join(import.meta.dirname, "../../../../..", "README.md"), "utf8")

/** The README's `## <heading>` section, from that heading up to the next `## ` one; empty when it has none */
export function section(heading: string): string {
	const start = README.indexOf(`\n## ${heading}\n`)
	if (start === -1) return ""
	const end = README.indexOf("\n## ", start + 1)
	return README.slice(start, end === -1 ? undefined : end)
}
