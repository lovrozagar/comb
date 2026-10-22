/**
 * Who may let a destructive migration run. A cautious file runs with `--yes` or a yes on a
 * terminal. An unsafe one loses data, so a standing `--yes` in a pipeline must not cover it: it
 * runs only on a yes from a person at a terminal, or when the file itself carries a reviewed
 * `-- comb:allow-unsafe: <reason>` line. atlas.sum records that line with the rest of the file's
 * bytes; comb's own hash leaves comments out, so it holds the SQL approved, not the approval.
 */
import type { Dialect, MigrationClassification } from "../types.ts"
import { extractDropStatements } from "./classify.ts"
import { segments } from "./sql-scan.ts"
import { dropsQuestion } from "./utils.ts"

/** The parts of a parsed migration the decision reads */
type Reviewed = { classification: MigrationClassification; drops: readonly string[]; filename: string; sql: string }

type ApprovalOptions = {
	/** how to ask the person running the migration; absent when nobody can be asked */
	confirm?: ((question: string) => Promise<boolean>) | undefined
	/** how the file is read, so only a real comment approves it; SQLite by default */
	dialect?: Dialect | undefined
	/** the database it runs on, named in the question */
	target: string
	/** --yes */
	yes: boolean
}

/** May run, with the in-file approval to report when that is what let it; or refused, and why */
type Approval = { approvedBy?: string | undefined; ok: true } | { message: string; ok: false }

const ALLOW_UNSAFE = /^--[ \t]*comb:allow-unsafe:[ \t]*(\S.*?)[ \t]*$/
const MARKER = '"-- comb:allow-unsafe: <reason>"'

/**
 * The reason a file gives for approving its own unsafe statements, if it gives one: a line
 * comment on a line of its own, never text inside a string or a function body
 */
function inFileApproval(sql: string, dialect: Dialect = "sqlite"): string | undefined {
	let lineStart = true
	for (const { kind, text } of segments(sql, dialect)) {
		const reason = kind === "comment" && lineStart ? ALLOW_UNSAFE.exec(text)?.[1] : undefined
		if (reason !== undefined) return reason
		lineStart = kind === "code" ? /(?:^|\n)[ \t]*$/.test(text) && (lineStart || text.includes("\n")) : false
	}
	return undefined
}

/** Whether `migration` may run on `options.target`, asking on a terminal when it must */
async function approveMigration(migration: Reviewed, options: ApprovalOptions): Promise<Approval> {
	const { classification: c } = migration
	if (c.safety === "safe") return { ok: true }
	const unsafe = c.safety === "unsafe"
	const approvedBy = unsafe ? inFileApproval(migration.sql, options.dialect) : undefined
	if (approvedBy !== undefined) return { approvedBy, ok: true }
	if (!unsafe && options.yes) return { ok: true }
	const statements = unsafe ? c.unsafeStatements : c.cautiousStatements
	/* a drop a listed statement already shows is not named twice: each is read for what it drops */
	const shown = new Set(statements.flatMap((stmt) => extractDropStatements(stmt, { dialect: options.dialect })))
	const drops = migration.drops.filter((drop) => !shown.has(drop))
	const listed = [...new Set([...drops, ...statements])]
	if (options.confirm !== undefined && (await options.confirm(dropsQuestion(listed, options.target))))
		return { ok: true }
	const how = unsafe
		? `confirm it on a terminal, or approve it in the file with a line ${MARKER}`
		: "pass --yes or confirm it on a terminal"
	return { message: `${migration.filename} is ${c.safety} (${listed.join("; ")}); ${how}`, ok: false }
}

export { type Approval, type ApprovalOptions, approveMigration, inFileApproval }
