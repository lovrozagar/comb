/**
 * The check every SQLite apply runs before it writes anything, and all `comb migrate check`
 * runs: the directory matches its atlas.sum, no pending file sorts before an applied one, and each
 * pending file is classified against the schema the files before it leave and approved as its
 * safety needs (approval.ts). It reads the history, so it needs the database, and applies nothing.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { Connection, ExtractedSchema, ParsedMigration } from "../types.ts"
import type { Approval } from "./approval.ts"
import { verifySum } from "./atlas-dir.ts"
import { refuseUnseenReach } from "./live-guard.ts"
import { parseMigration } from "./parse.ts"
import type { Run } from "./process.ts"
import { extractSchema } from "./schema.ts"

/** A pending migration: its file name and text, classified against the files before it */
type Pending = { before: ExtractedSchema; migration: ParsedMigration; name: string; sql: string }

type PlanOptions = {
	/** whether a classified migration may run: approval.ts's rule, asking a person when it must */
	approve(migration: ParsedMigration): Promise<Approval>
	/** whether the database records `name` (whose text is `sql`) as applied */
	applied(name: string, sql: string): boolean
	dir: string
	exec: Run
	/** the file names of `dir`, in the order they apply */
	files: readonly string[]
	print(line: string): void
	/** false for one file applied on its own, which no atlas.sum or order covers */
	whole?: boolean | undefined
	/** the database, whose own foreign keys and triggers a guarded rebuild is checked against */
	conn?: Connection | undefined
}

/** The leading number of a migration file name: `20260101000000_x.sql` is 20260101000000 */
const leadingNumber = (name: string): number => Number.parseInt(name.split("_")[0] as string, 10)

/** A file's place by its leading number; one without a number goes after every one with */
const rank = (name: string): number => {
	const number = leadingNumber(name)
	return Number.isFinite(number) ? number : Number.POSITIVE_INFINITY
}

/** The order wrangler applies D1 migrations in: by leading number, files without one last, then by name */
function wranglerOrder(names: readonly string[]): string[] {
	/* two files without a number differ by NaN, which falls through to the name, compared as wrangler does */
	return names.toSorted((a, b) => rank(a) - rank(b) || Number(a > b) - Number(a < b))
}

/** Refuses a pending file that sorts before an applied one: it would run after files written later */
function refuseOutOfOrder(files: readonly string[], applied: ReadonlySet<string>): void {
	const last = files.findLastIndex((name) => applied.has(name))
	const late = files.slice(0, Math.max(last, 0)).find((name) => !applied.has(name))
	if (late !== undefined) {
		throw new Error(
			`${late} was never applied, yet it sorts before ${files[last] as string}, which was; rename it to sort after the applied files`,
		)
	}
}

/** Check the pending migrations of `options.files` and approve each; returns them in apply order */
async function planApply(options: PlanOptions): Promise<Pending[]> {
	const { dir, files, print } = options
	if (options.whole !== false) verifySum(options.exec, dir)
	const texts = files.map((name) => readFileSync(join(dir, name), "utf8"))
	const applied = new Set(files.filter((name, i) => options.applied(name, texts[i] as string)))
	if (options.whole !== false) refuseOutOfOrder(files, applied)
	const pending: Pending[] = []
	let schema = extractSchema("")
	for (const [i, name] of files.entries()) {
		const sql = texts[i] as string
		const before = schema
		schema = extractSchema(sql, before)
		if (applied.has(name)) continue
		const migration = parseMigration(sql, name, { before, dialect: "sqlite" })
		const approval = await options.approve(migration)
		if (!approval.ok) throw new Error(approval.message)
		if (approval.approvedBy !== undefined) print(`Approved in ${name}: ${approval.approvedBy}`)
		pending.push({ before, migration, name, sql })
	}
	if (options.conn !== undefined) await refuseUnseenReach(options.conn, pending)
	return pending
}

export { type Pending, planApply, type PlanOptions, wranglerOrder }
