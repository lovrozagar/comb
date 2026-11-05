/**
 * A file's verdict from its statements' readings (classify.ts): each statement Postgres or D1
 * cannot run refused first, then the file rated at the strictest level any reading gives a
 * statement, with the statements that make it so, the ones that lock a table, and the ones whose
 * effect waits on data
 */
import type { MigrationClassification } from "../types.ts"
import type { Finding } from "./classify-alter.ts"
import { preview, type ReadStatement, refuseOpenBlock, refuseUnrunnable } from "./classify-file.ts"
import type { TargetKind } from "./classify-target.ts"
import { outsideTransaction } from "./atlas-header.ts"

/** A statement read, with what each rule found in it */
type Read = ReadStatement & { findings: Finding[] }

/** One entry per statement a kept finding names: the statement once, each of its notes once (S6 of r18) */
const entries = (reads: readonly Read[], keep: (finding: Finding) => boolean) =>
	reads.flatMap(({ findings, stmt }) => {
		const kept = findings.filter(keep)
		if (kept.length === 0) return []
		const notes = [...new Set(kept.flatMap(({ note }) => (note === undefined ? [] : [note])))]
		return [notes.length === 0 ? preview(stmt) : `${preview(stmt)} (${notes.join("; ")})`]
	})
const at = (level: Finding["level"]) => (finding: Finding) => finding.level === level

/** classifyMigration of the readings of `sql` */
function classificationOf(
	reads: readonly Read[],
	sql: string,
	{ kind = "local" }: { kind?: TargetKind | undefined } = {},
): MigrationClassification {
	for (const read of reads) refuseUnrunnable(read, sql, kind)
	refuseOpenBlock(reads, sql)
	const unsafeStatements = [...new Set(entries(reads, at("unsafe")))]
	/* a statement is listed once, at the strictest level any reading gives it, whatever each finding's note */
	const unsafe = new Set(
		reads.filter(({ findings }) => findings.some((f) => f.level === "unsafe")).map(({ stmt }) => preview(stmt)),
	)
	const cautiousStatements = [
		...new Set(
			entries(
				reads.filter(({ stmt }) => !unsafe.has(preview(stmt))),
				at("cautious"),
			),
		),
	]
	if (outsideTransaction(sql))
		cautiousStatements.push("-- atlas:txmode none: the file is not applied in one transaction")
	const safety = unsafeStatements.length > 0 ? "unsafe" : cautiousStatements.length > 0 ? "cautious" : "safe"
	return {
		cautiousStatements,
		lockWarnings: [...new Set(entries(reads, at("lock")))],
		pendingStatements: [...new Set(entries(reads, (finding) => finding.pending === true))],
		safety,
		unsafeStatements,
	}
}

export { classificationOf, type Read }
