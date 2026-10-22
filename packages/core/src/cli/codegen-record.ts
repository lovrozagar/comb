/**
 * What a codegen run commits: every database's staged files at once, the record of what each wrote,
 * and the files a database's last run wrote that this one did not, removed when comb wrote them.
 */
import fs from "node:fs"
import path from "node:path"
import { commitStaged, isGeneratedContent, type Staged, writeGenJsonFile } from "../codegen/utils/fs.ts"
import { CliError } from "./output.ts"

/*
 * What each database's last run wrote, in one record beside comb.config.ts (beside the tables file in
 * direct mode), keyed by database name, its paths relative to the record: a run after filePrefix or
 * output.default moved still finds the last run's files, wherever they were.
 */
const RECORD = ".comb.codegen.json"

type RunRecord = { databases: Record<string, string[]> }

function readRecord(recordPath: string): RunRecord {
	if (!fs.existsSync(recordPath)) return { databases: {} }
	try {
		return JSON.parse(fs.readFileSync(recordPath, "utf8")) as RunRecord
	} catch (error) {
		throw new CliError(
			`${RECORD} is not JSON (a merge conflict?): delete it, and the next run removes nothing stale; ${(error as Error).message}`,
		)
	}
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
 * wrote, then delete each file a database's last run wrote that no database wrote this time, as
 * long as comb wrote it (F15). A file without comb's header is never touched. A run of some
 * generators (-g) only adds to a database's record: it cannot tell the others' files stale. A run
 * of the whole config names every database it `declared`, and a record entry it does not name is
 * a database renamed or removed, whose files are stale too (F14). Two databases that wrote one path
 * would overwrite each other, so that fails before anything is written (F16).
 */
export function commitRuns(
	staged: Staged,
	runs: readonly Run[],
	{ declared, recordDir }: { declared?: readonly string[] | undefined; recordDir: string },
): void {
	refuseShared(runs, recordDir)
	const recordPath = path.join(recordDir, RECORD)
	const record = readRecord(recordPath)
	const before: string[] = []
	const now = new Set<string>()
	for (const run of runs) {
		const last = [
			...(record.databases[run.name] ?? []).map((file) => path.resolve(recordDir, file)),
			...legacyFiles(run.root, run.prefix),
		]
		const kept = new Set([...run.wrote, ...(run.partial ? last : [])])
		record.databases[run.name] = [...kept].map((file) => path.relative(recordDir, file)).sort()
		before.push(...last)
		for (const file of kept) now.add(file)
	}
	const gone = Object.entries(record.databases).filter(([each]) => declared !== undefined && !declared.includes(each))
	for (const [name, files] of gone) {
		before.push(...files.map((file) => path.resolve(recordDir, file)))
		delete record.databases[name]
	}
	/* by name, so the databases in any order write the same bytes (F32) */
	record.databases = Object.fromEntries(Object.entries(record.databases).sort(([a], [b]) => a.localeCompare(b)))
	writeGenJsonFile(recordPath, record, { generator: "comb", staged })
	commitStaged(staged)
	for (const file of before.filter((each) => !now.has(each))) removeStale(file, recordDir)
	for (const run of runs) fs.rmSync(legacyRecord(run.root, run.prefix), { force: true })
}

/** A path two databases wrote: neither may own it, as the second would replace the first's tables */
function refuseShared(runs: readonly Run[], recordDir: string): void {
	const owner = new Map<string, string>()
	for (const run of runs) {
		for (const file of run.wrote) {
			const first = owner.get(file)
			if (first !== undefined && first !== run.name) {
				throw new Error(
					`databases ${first} and ${run.name} both write ${path.relative(recordDir, file)}; give each its own filePrefix or output`,
				)
			}
			owner.set(file, run.name)
		}
	}
}
