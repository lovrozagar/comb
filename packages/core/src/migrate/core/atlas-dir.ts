/**
 * A migrations directory as Atlas reads it: its .sql files in name order and atlas.sum, the
 * checksum Atlas keeps over them. comb hashes copies it hands Atlas, checks a directory's sum
 * against a fresh hash, line by line whatever its line ends, and snapshots a directory, so Atlas
 * applies exactly the bytes comb read.
 */
import { copyFileSync, existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { Run } from "./process.ts"
import { type Scratch, scratchDir } from "./cleanup.ts"

/** The migration files of `dir`, in the order Atlas applies them */
function sqlFiles(dir: string): string[] {
	return readdirSync(dir)
		.filter((file) => file.endsWith(".sql"))
		.sort()
}

/** Write `dir`'s atlas.sum with `atlas migrate hash` */
async function hashDir(exec: Run, dir: string): Promise<void> {
	const result = await exec("atlas", ["migrate", "hash", "--dir", `file://${dir}`])
	if (result.code !== 0) throw new Error(`atlas migrate hash failed: ${result.stderr.trim()}`)
}

/**
 * The lines of the atlas.sum at `path`, split on LF or CRLF: Atlas validates a sum git's autocrlf
 * checked out with CRLF line ends, so comb reads its entries, not its bytes (PA19 of r22b)
 */
const sumLines = (path: string): string[] => readFileSync(path, "utf8").split(/\r?\n/)

/** Each file's hash as atlas.sum records it, without the `h1:` prefix */
function sumHashes(dir: string): Map<string, string> {
	const sum = join(dir, "atlas.sum")
	if (!existsSync(sum)) return new Map()
	const lines = sumLines(sum).slice(1)
	const pairs = lines.flatMap((line) => {
		const match = /^(\S+) h1:(\S+)$/.exec(line)
		return match === null ? [] : [[match[1] as string, match[2] as string] as const]
	})
	return new Map(pairs)
}

/** Refuse a directory whose atlas.sum does not match its files: comb hashes an untouched copy and compares */
async function verifySum(exec: Run, dir: string, shown: string = dir): Promise<void> {
	/* a directory with no migration and no sum, as `comb migrate init` makes it, is an empty history (S9, K3) */
	if (!existsSync(join(dir, "atlas.sum"))) {
		if (sqlFiles(dir).length === 0) return
		throw new Error(
			`${shown} has migrations but no atlas.sum; comb migrate diff writes a migration and its sum, and atlas migrate hash --dir file://${shown} hashes ones written by hand`,
		)
	}
	const { dir: check, remove: removeCheck } = scratchDir("comb-migrate-sum-")
	try {
		for (const file of sqlFiles(dir)) copyFileSync(join(dir, file), join(check, file))
		await hashDir(exec, check)
		if (sumLines(join(check, "atlas.sum")).join("\n") !== sumLines(join(dir, "atlas.sum")).join("\n")) {
			throw new Error(
				`${shown}/atlas.sum does not match its migrations; if a migration was edited on purpose, run atlas migrate hash`,
			)
		}
	} finally {
		removeCheck()
	}
}

/**
 * A private 0700 copy of `dir`'s migrations and atlas.sum, checked against the sum. What comb
 * classifies and what Atlas applies are both read from it, so an edit to `dir` in between changes
 * nothing; the caller removes it.
 */
async function snapshotDir(exec: Run, dir: string): Promise<Scratch> {
	const snapshot = scratchDir("comb-migrate-snapshot-")
	try {
		const sum = existsSync(join(dir, "atlas.sum")) ? ["atlas.sum"] : []
		for (const file of [...sqlFiles(dir), ...sum]) copyFileSync(join(dir, file), join(snapshot.dir, file))
		await verifySum(exec, snapshot.dir, dir)
		return snapshot
	} catch (error) {
		snapshot.remove()
		throw error
	}
}

/** The version one second after `version` (YYYYMMDDHHMMSS, UTC) */
function nextVersion(version: string): string {
	const at = (from: number, to: number) => Number(version.slice(from, to))
	const next = new Date(Date.UTC(at(0, 4), at(4, 6) - 1, at(6, 8), at(8, 10), at(10, 12), at(12, 14) + 1))
	return next.toISOString().replace(/\D/g, "").slice(0, 14)
}

/**
 * The version for a migration comb names itself: now, or a second past the directory's latest
 * when that is not earlier, so two diffs in one second, or a file stamped ahead, never share or
 * invert an order
 */
function freshVersion(dir: string, now: Date = new Date()): string {
	const stamp = now.toISOString().replace(/\D/g, "").slice(0, 14)
	const latest = sqlFiles(dir)
		.map((file) => /^(\d{14})_/.exec(file)?.[1])
		.filter((version): version is string => version !== undefined)
		.at(-1)
	return latest === undefined || stamp > latest ? stamp : nextVersion(latest)
}

export { freshVersion, hashDir, nextVersion, snapshotDir, sqlFiles, sumHashes, verifySum }
