/**
 * A migrations directory as Atlas reads it: its .sql files in name order and atlas.sum, the
 * checksum Atlas keeps over them. comb hashes copies it hands Atlas, checks a directory's sum
 * against a fresh hash, and snapshots a directory, so Atlas applies exactly the bytes comb read.
 */
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Run } from "./process.ts"

/** The migration files of `dir`, in the order Atlas applies them */
function sqlFiles(dir: string): string[] {
	return readdirSync(dir)
		.filter((file) => file.endsWith(".sql"))
		.sort()
}

/** Write `dir`'s atlas.sum with `atlas migrate hash` */
function hashDir(exec: Run, dir: string): void {
	const result = exec("atlas", ["migrate", "hash", "--dir", `file://${dir}`])
	if (result.code !== 0) throw new Error(`atlas migrate hash failed: ${result.stderr}`)
}

/** Each file's hash as atlas.sum records it, without the `h1:` prefix */
function sumHashes(dir: string): Map<string, string> {
	const sum = join(dir, "atlas.sum")
	if (!existsSync(sum)) return new Map()
	const lines = readFileSync(sum, "utf8").split("\n").slice(1)
	const pairs = lines.flatMap((line) => {
		const match = /^(\S+) h1:(\S+)$/.exec(line)
		return match === null ? [] : [[match[1] as string, match[2] as string] as const]
	})
	return new Map(pairs)
}

/** Refuse a directory whose atlas.sum does not match its files: comb hashes an untouched copy and compares */
function verifySum(exec: Run, dir: string, shown: string = dir): void {
	const check = mkdtempSync(join(tmpdir(), "comb-migrate-sum-"))
	try {
		for (const file of sqlFiles(dir)) copyFileSync(join(dir, file), join(check, file))
		hashDir(exec, check)
		if (readFileSync(join(check, "atlas.sum"), "utf8") !== readFileSync(join(dir, "atlas.sum"), "utf8")) {
			throw new Error(
				`${shown}/atlas.sum does not match its migrations; if a migration was edited on purpose, run atlas migrate hash`,
			)
		}
	} finally {
		rmSync(check, { force: true, recursive: true })
	}
}

/**
 * A private 0700 copy of `dir`'s migrations and atlas.sum, checked against the sum. What comb
 * classifies and what Atlas applies are both read from it, so an edit to `dir` in between changes
 * nothing; the caller removes it.
 */
function snapshotDir(exec: Run, dir: string): string {
	const copy = mkdtempSync(join(tmpdir(), "comb-migrate-snapshot-"))
	try {
		for (const file of [...sqlFiles(dir), "atlas.sum"]) copyFileSync(join(dir, file), join(copy, file))
		verifySum(exec, copy, dir)
		return copy
	} catch (error) {
		rmSync(copy, { force: true, recursive: true })
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
