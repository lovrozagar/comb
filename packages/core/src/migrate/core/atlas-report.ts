/**
 * Atlas's report of a `migrate apply`, a dry run's or an apply's, as `--format APPLY_FORMAT` writes
 * it: the files it ran, each with the statements it ran of them, and the error that stopped it.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { explainAtlasFailure } from "./atlas-target.ts"
import { json, type Ran } from "./atlas-status.ts"
import { outsideTransaction } from "./classify-file.ts"

const APPLY_FORMAT = '{"target":{{ json .Target }},"applied":{{ json .Applied }},"error":{{ json .Error }}}'

/** A file Atlas ran: the statements it ran of it, the one that failed last */
type AppliedFile = { Applied: string[]; Error?: { Stmt: string; Text: string }; Name: string }
/** Atlas writes `applied` as null when it ran no file, as when another apply ran them first (P8) */
type ApplyReport = { applied: AppliedFile[] | null; error: string }

/** What stays of `file`, of the snapshot `copy`, which failed: a file outside a transaction keeps what it ran (P10) */
function aftermath(copy: string, file: AppliedFile): string {
	if (!outsideTransaction(readFileSync(join(copy, file.Name), "utf8")))
		return "It was rolled back; the files before it stay applied"
	/* Atlas lists the statement that failed last */
	const ran = file.Applied.length - 1
	if (ran === 0)
		return "It ran outside a transaction and failed at its first statement, so nothing of it stays applied; the files before it do"
	return `It ran outside a transaction, so ${ran === 1 ? "the statement it ran before that stays" : `the ${ran} statements it ran before that stay`} applied, as do the files before it; while the file is unchanged, migrate apply resumes after them`
}

/**
 * The files Atlas's `migrate <command>` on the snapshot `copy` ran, by name; the file and statement
 * that failed, or the error its report or else its stderr holds, thrown (P9)
 */
function reported(ran: Ran, command: string, copy: string): string[] {
	const out = ran.stdout.trim()
	/* Atlas writes some refusals, such as a checksum error, as text, with its reason on stderr */
	if (out === "" || (ran.code !== 0 && !out.startsWith("{"))) throw new Error(`atlas migrate ${command}: ${ran.said}`)
	const report = json<ApplyReport>(out, command)
	const files = report.applied ?? []
	const failed = files.find((file) => file.Error !== undefined)
	if (failed?.Error !== undefined) {
		const { Stmt, Text } = failed.Error
		throw new Error(`${failed.Name} failed at ${ran.scrub(Stmt)}: ${ran.scrub(Text)}. ${aftermath(copy, failed)}`)
	}
	if (ran.code !== 0 || report.error !== "")
		throw new Error(
			`atlas migrate ${command}: ${report.error === "" ? ran.said : explainAtlasFailure(report.error, ran.scrub)}`,
		)
	return files.map((file) => file.Name)
}

export { APPLY_FORMAT, reported }
