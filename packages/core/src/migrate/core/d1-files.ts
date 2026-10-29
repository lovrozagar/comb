/**
 * A D1 migrations directory as wrangler reads it (S1, S4, C8 of the 0.14.1 review). wrangler
 * applies every `*.sql` file whose name does not start with a dot, by leading number, and sends
 * each with its history INSERT appended on the next line; Atlas hashes and diffs every `*.sql`
 * file, by name. A directory where the two lists or orders differ is refused, naming the file to
 * rename, and so is a pending file whose end would swallow wrangler's INSERT.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sqlFiles } from "./atlas-dir.ts"
import { wranglerOrder } from "./plan-apply.ts"
import { segments } from "./sql-scan.ts"

/**
 * The migration files of the D1 directory `dir`, in wrangler's order, with their text; refused
 * where wrangler would skip one Atlas applies, or run them in an order Atlas does not
 */
function d1Files(dir: string): Array<{ name: string; sql: string }> {
	const atlas = sqlFiles(dir)
	const dotted = atlas.find((name) => name.startsWith("."))
	if (dotted !== undefined) {
		throw new Error(
			`${dotted} starts with a dot, so wrangler never applies it, while Atlas does; rename it without the dot`,
		)
	}
	const wrangler = wranglerOrder(atlas)
	const at = wrangler.findIndex((name, i) => name !== atlas[i])
	if (at !== -1) {
		const [misplaced, other] = [atlas[at] as string, wrangler[at] as string]
		throw new Error(
			`${misplaced} runs after ${other} under wrangler, by number, but before it under Atlas, by name; rename ${misplaced} so the names sort as their numbers do, as same-width timestamps do`,
		)
	}
	return wrangler.map((name) => ({ name, sql: readFileSync(join(dir, name), "utf8") }))
}

/** Why wrangler's history INSERT, appended to `sql` on the next line, would not run as a statement of its own; none when it would */
function swallowed(sql: string): string | undefined {
	const parts = segments(sql).filter(({ kind, text }) => kind !== "code" || text.trim() !== "")
	const last = parts.at(-1)
	if (last?.kind === "comment" && last.text.startsWith("/*") && !last.text.endsWith("*/"))
		return "ends inside an open /* comment"
	const statement = parts.findLast(({ kind }) => kind !== "comment")
	if (statement === undefined || (statement.kind === "code" && statement.text.trimEnd().endsWith(";"))) return undefined
	return "does not end its last statement with ;"
}

/** Refuse a pending file whose end would swallow the history INSERT wrangler appends, so it would run again on every apply */
function refuseSwallowing(files: ReadonlyArray<{ name: string; sql: string }>): void {
	for (const { name, sql } of files) {
		const why = swallowed(sql)
		if (why !== undefined) {
			throw new Error(
				`${name} ${why}: wrangler appends its history INSERT on the next line, which this would swallow, so the file would run again on every apply; close the comment and end the statement with ;`,
			)
		}
	}
}

export { d1Files, refuseSwallowing }
