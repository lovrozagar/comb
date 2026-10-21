/**
 * The check every SQLite apply runs before it writes anything, and all `comb migrate check`
 * runs: the directory matches its atlas.sum, no pending file sorts before an applied one, and each
 * pending file is classified against the schema the files before it leave, proven on a seeded
 * in-memory copy of the database's own schema (proof-run.ts), and approved as the stricter of the
 * two needs (approval.ts). A target with no tables of its own and no applied history holds nothing
 * a file could lose, so its files skip the approval, and the output says "empty target". It reads
 * the database, and applies nothing to it.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { Connection, ExtractedSchema, ParsedMigration } from "../types.ts"
import type { Approval } from "./approval.ts"
import { verifySum } from "./atlas-dir.ts"
import { refuseUnseenReach } from "./live-guard.ts"
import { parseMigration } from "./parse.ts"
import { type Proof, provePending } from "./proof-run.ts"
import { Refused } from "./refused.ts"
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

/**
 * `migration` with its proof joined to its classification: the stricter of the two counts, each
 * finding of the proof listed as `proof run: …`
 */
function withProof(migration: ParsedMigration, proof: Proof): ParsedMigration {
	const { classification } = migration
	const unsafeStatements = [...classification.unsafeStatements, ...proof.unsafe.map((note) => `proof run: ${note}`)]
	const cautiousStatements = [
		...classification.cautiousStatements,
		...proof.cautious.map((note) => `proof run: ${note}`),
	]
	const safety =
		unsafeStatements.length > 0 ? "unsafe" : cautiousStatements.length > 0 ? "cautious" : classification.safety
	return { ...migration, classification: { ...classification, cautiousStatements, safety, unsafeStatements } }
}

/** What the proof could not prove of a file, as lines to print */
function proofGaps(name: string, proof: Proof): string[] {
	const gaps = proof.failed === undefined ? [] : [`Proof run: ${name}: ${proof.failed}; its rating is the classifier's`]
	if (proof.unproven.length > 0)
		gaps.push(`Proof run: ${name}: unproven, comb could not seed ${proof.unproven.join(", ")}`)
	return gaps
}

/** Each unapplied file, classified against the schema the files before it leave */
function classifyPending(files: readonly string[], texts: readonly string[], applied: ReadonlySet<string>): Pending[] {
	const pending: Pending[] = []
	let schema = extractSchema("")
	for (const [i, name] of files.entries()) {
		const sql = texts[i] as string
		const before = schema
		schema = extractSchema(sql, before)
		if (!applied.has(name))
			pending.push({ before, migration: parseMigration(sql, name, { before, dialect: "sqlite" }), name, sql })
	}
	return pending
}

/** Whether the database holds no table but SQLite's, D1's and the migration histories: nothing in it can be lost */
async function isEmptyTarget(conn: Connection): Promise<boolean> {
	const { rows } = await conn.execute(
		"SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT IN ('__drizzle_migrations', 'd1_migrations')",
	)
	return Number(rows[0]?.[0]) === 0
}

/**
 * Each classified file with its proof joined, approved in order; on an empty target, said once and
 * approved without asking, as nothing in it can be lost
 */
async function approveAll(
	classified: readonly Pending[],
	{ empty, options, proofs }: { empty: boolean; options: PlanOptions; proofs: ReadonlyMap<string, Proof> },
): Promise<Pending[]> {
	const { print } = options
	if (empty) {
		const n = classified.length
		print(
			`Empty target: no tables and no applied history, so nothing can be lost; ${n} file${n === 1 ? "" : "s"} apply without the unsafe gate`,
		)
	}
	const pending: Pending[] = []
	for (const each of classified) {
		const proof = proofs.get(each.name)
		const migration = proof === undefined ? each.migration : withProof(each.migration, proof)
		for (const line of proof === undefined ? [] : proofGaps(each.name, proof)) print(line)
		const approval = empty ? { ok: true as const } : await options.approve(migration)
		if (!approval.ok)
			throw new Refused(
				approval.message,
				classified.map(({ name }) => name),
			)
		if (approval.approvedBy !== undefined) print(`Approved in ${each.name}: ${approval.approvedBy}`)
		pending.push({ ...each, migration })
	}
	return pending
}

/** Check the pending migrations of `options.files`, prove them on the database's schema, and approve each; returns them in apply order */
async function planApply(options: PlanOptions): Promise<Pending[]> {
	const { conn, dir, files } = options
	if (options.whole !== false) verifySum(options.exec, dir)
	const texts = files.map((name) => readFileSync(join(dir, name), "utf8"))
	const applied = new Set(files.filter((name, i) => options.applied(name, texts[i] as string)))
	if (options.whole !== false) refuseOutOfOrder(files, applied)
	const classified = classifyPending(files, texts, applied)
	const proofs =
		conn === undefined || classified.length === 0 ? new Map<string, Proof>() : await provePending(conn, classified)
	const empty = conn !== undefined && applied.size === 0 && classified.length > 0 && (await isEmptyTarget(conn))
	const pending = await approveAll(classified, { empty, options, proofs })
	if (conn !== undefined) await refuseUnseenReach(conn, pending)
	return pending
}

export { type Pending, planApply, type PlanOptions, wranglerOrder }
