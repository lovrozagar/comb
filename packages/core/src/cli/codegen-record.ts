/**
 * What a codegen run commits: every database's staged files at once, the record of what each wrote,
 * and the files a database's last run wrote that this one did not, removed when comb wrote them.
 */
import fs from "node:fs"
import path from "node:path"
import { commitStaged, isGeneratedContent, type Staged, writeGenJsonFile } from "../codegen/utils/fs.ts"

/*
 * What each database's last run wrote, in one record beside comb.config.ts (beside the tables file in
 * direct mode), keyed by database name, its paths relative to the record: a run after filePrefix or
 * output.default moved still finds the last run's files, wherever they were.
 */
const RECORD = ".comb.codegen.json"

type RunRecord = { databases: Record<string, string[]> }

function readRecord(recordPath: string): RunRecord {
	if (!fs.existsSync(recordPath)) return { databases: {} }
	return JSON.parse(fs.readFileSync(recordPath, "utf8")) as RunRecord
}

/* 0.9's record, one per output root and file prefix: read once, so the first run after an upgrade still removes its files */
const legacyRecord = (root: string, prefix: string): string => path.join(root, `.${prefix}.codegen.json`)

/** The absolute paths 0.9's record at `root` lists; none when there is no such record */
function legacyFiles(root: string, prefix: string): string[] {
	const file = legacyRecord(root, prefix)
	if (!fs.existsSync(file)) return []
	return (JSON.parse(fs.readFileSync(file, "utf8")) as { files: string[] }).files.map((each) =>
		path.resolve(root, each),
	)
}

/** Remove `dir` and its parents while they are empty, up to `root` */
function pruneEmpty(dir: string, root: string): void {
	for (let at = dir; at.startsWith(root) && at !== root && fs.readdirSync(at).length === 0; at = path.dirname(at))
		fs.rmdirSync(at)
}

/** One database's staged run: its name, where its files go, and which of the staged files it wrote */
export type Run = { name: string; partial: boolean; prefix: string; root: string; wrote: string[] }

/** Delete `file` when comb wrote it, and the directories it leaves empty, up to `top` */
function removeStale(file: string, top: string): void {
	if (!fs.existsSync(file) || !isGeneratedContent(fs.readFileSync(file, "utf8"))) return
	fs.unlinkSync(file)
	pruneEmpty(path.dirname(file), top)
}

/**
 * Write everything the run staged, once every database's generators have run, record what each
 * wrote, then delete each file a database's last run wrote and this one did not, as long as comb
 * wrote it. A file without comb's header is never touched. A run of some generators (-g) only adds
 * to a database's record: it cannot tell the others' files stale.
 */
export function commitRuns(staged: Staged, runs: readonly Run[], recordDir: string): void {
	const recordPath = path.join(recordDir, RECORD)
	const record = readRecord(recordPath)
	const stale: string[] = []
	for (const run of runs) {
		const before = [
			...(record.databases[run.name] ?? []).map((file) => path.resolve(recordDir, file)),
			...legacyFiles(run.root, run.prefix),
		]
		const now = new Set([...run.wrote, ...(run.partial ? before : [])])
		record.databases[run.name] = [...now].map((file) => path.relative(recordDir, file)).sort()
		stale.push(...before.filter((file) => !now.has(file)))
	}
	writeGenJsonFile(recordPath, record, { generator: "comb", staged })
	commitStaged(staged)
	for (const file of stale) removeStale(file, recordDir)
	for (const run of runs) fs.rmSync(legacyRecord(run.root, run.prefix), { force: true })
}
