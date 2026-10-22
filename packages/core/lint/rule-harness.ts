import { type SpawnSyncReturns, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { parseSync } from "oxc-parser"

/** Repo-relative path → source. A rule decides by path, so a fixture mirrors the real layout. */
export type Fixture = Record<string, string>

/** One finding: the fixture path it is in and the rule's message. */
export type Report = { file: string; message: string }

type Comment = { end: number; start: number; type: string; value: string }
type Node = { end: number; parent?: Node | null; start: number; type: string }
type Context = {
	filename: string
	report(descriptor: { message: string; node: unknown }): void
	sourceCode: {
		getAllComments(): Comment[]
		getCommentsAfter(node: Node): Comment[]
		getCommentsBefore(node: Node): Comment[]
		getText(): string
	}
}
type Visitors = Record<string, ((node: never) => void) | undefined>
type Rule = { create(context: Context): Visitors }

const PLUGIN = join(import.meta.dirname, "index.js")
const OXLINT = join(dirname(createRequire(import.meta.url).resolve("oxlint/package.json")), "bin", "oxlint")

/* the comments that touch `node` with only whitespace between, as ESLint's SourceCode reports them */
function commentsBefore(code: string, comments: Comment[], node: Node): Comment[] {
	const out: Comment[] = []
	let edge = node.start
	for (const comment of comments.toReversed()) {
		if (comment.end > edge) continue
		if (code.slice(comment.end, edge).trim() !== "") break
		out.unshift(comment)
		edge = comment.start
	}
	return out
}

function commentsAfter(code: string, comments: Comment[], node: Node): Comment[] {
	const out: Comment[] = []
	let edge = node.end
	for (const comment of comments) {
		if (comment.start < edge) continue
		if (code.slice(edge, comment.start).trim() !== "") break
		out.push(comment)
		edge = comment.end
	}
	return out
}

function walk(node: unknown, parent: Node | null, visitors: Visitors): void {
	if (typeof node !== "object" || node === null || !("type" in node)) return
	const record = node as Node
	record.parent = parent
	visitors[record.type]?.(record as never)
	for (const [key, value] of Object.entries(record)) {
		if (key === "parent") continue
		for (const child of Array.isArray(value) ? value : [value]) walk(child, record, visitors)
	}
}

/** Runs `rule` in process over every fixture file, the way oxlint hands it each file. */
export function reportsOf(rule: Rule, fixture: Fixture): Report[] {
	const reports: Report[] = []
	for (const [file, code] of Object.entries(fixture)) {
		const filename = `/repo/${file}`
		const parsed = parseSync(filename, code)
		const comments = parsed.comments as Comment[]
		const visitors = rule.create({
			filename,
			report: ({ message }) => reports.push({ file, message }),
			sourceCode: {
				getAllComments: () => comments,
				getCommentsAfter: (node) => commentsAfter(code, comments, node),
				getCommentsBefore: (node) => commentsBefore(code, comments, node),
				getText: () => code,
			},
		})
		walk(parsed.program, null, visitors)
	}
	return reports
}

function insideGitCheckout(dir: string): boolean {
	for (let at = dir; at !== dirname(at); at = dirname(at)) if (existsSync(join(at, ".git"))) return true
	return false
}

/** What `oxlint --format json` prints */
type OxlintReport = { diagnostics: Array<{ filename: string; message: string }> }

/**
 * The report a finished oxlint run printed. A child that printed none, killed by a signal (a
 * SIGKILL under memory pressure leaves neither stdout nor stderr), failed to start or exited with
 * an error, fails naming its exit, signal, spawn error and stderr, so the next one names itself.
 */
export function oxlintJson(
	proc: Pick<SpawnSyncReturns<string>, "error" | "signal" | "status" | "stderr" | "stdout">,
): OxlintReport {
	try {
		return JSON.parse(proc.stdout) as OxlintReport
	} catch {
		const spawn = proc.error === undefined ? "" : `, ${proc.error.message}`
		const stderr = proc.stderr?.trim() || "no stderr"
		throw new Error(
			`oxlint printed no JSON report (exit ${proc.status}, signal ${proc.signal ?? "none"}${spawn}): ${stderr}`,
		)
	}
}

/** Runs the real oxlint binary with the comb plugin and only `comb/<name>` on, over the fixture. */
export function oxlintReports(name: string, fixture: Fixture): Report[] {
	const dir = mkdtempSync(join(tmpdir(), "comb-lint-"))
	try {
		/* oxlint applies a checkout's .gitignore even with --no-ignore, so a fixture inside one lints nothing */
		if (insideGitCheckout(dir)) throw new Error(`TMPDIR ${tmpdir()} is inside a git checkout; set it outside one`)
		const config = {
			categories: { correctness: "off", suspicious: "off" },
			jsPlugins: [{ name: "comb", specifier: PLUGIN }],
			plugins: [],
			rules: { [`comb/${name}`]: "error" },
		}
		writeFileSync(join(dir, ".oxlintrc.json"), JSON.stringify(config))
		for (const [file, code] of Object.entries(fixture)) {
			mkdirSync(dirname(join(dir, file)), { recursive: true })
			writeFileSync(join(dir, file), code)
		}
		const files = Object.keys(fixture).map((file) => join(dir, file))
		const args = ["--config", join(dir, ".oxlintrc.json"), "--format", "json", "--no-ignore", ...files]
		const proc = spawnSync(OXLINT, args, { encoding: "utf8" })
		return oxlintJson(proc)
			.diagnostics.map((d) => ({ file: d.filename.slice(dir.length + 1), message: d.message }))
			.sort((a, b) => a.file.localeCompare(b.file))
	} finally {
		rmSync(dir, { force: true, recursive: true })
	}
}
