/**
 * comb/public-jsdoc runs as `error` on the entries already documented, through its `entries` option in the src
 * override of .oxlintrc.json, so an entry stays clean once it is swept. This holds that list to exactly the entries
 * whose own surface lints clean, in `exports` order: a sweep that clears an entry adds it here, and once every entry
 * is listed the option goes and the rule is a plain `error`.
 */
import { readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"
import { rule } from "../../lint/public-jsdoc.js"
import { publicSurface } from "../../lint/public-surface.js"
import { reportsOf } from "../../lint/rule-harness.ts"

const CORE = join(import.meta.dirname, "../..")
const REPO = join(CORE, "../..")

type Override = { files: string[]; rules?: Record<string, unknown> }

/* the entries whose default condition names a file under ./src/, the ones the rule reads */
function sourceEntries(): string[] {
	const manifest = JSON.parse(readFileSync(join(CORE, "package.json"), "utf8")) as { exports: Record<string, unknown> }
	return Object.entries(manifest.exports)
		.filter(([, value]) => {
			const target = typeof value === "object" && value !== null ? (value as { default?: unknown }).default : undefined
			return typeof target === "string" && target.startsWith("./src/")
		})
		.map(([key]) => key)
}

/* the rule's setting in the override that lints src */
function setting(): unknown {
	const config = JSON.parse(readFileSync(join(REPO, ".oxlintrc.json"), "utf8")) as { overrides: Override[] }
	const src = config.overrides.find((override) => override.files.includes("packages/core/src/**"))
	return src?.rules?.["comb/public-jsdoc"]
}

/* what the rule reports on `entry`'s surface alone: every file it names a declaration in or finds a form in */
function reportsThrough(entry: string): string[] {
	const surface = publicSurface(CORE, [entry])
	const files = new Set([...surface.names.keys(), ...surface.unknown.map(({ file }) => file)])
	const fixture = Object.fromEntries([...files].map((file) => [relative(REPO, file), readFileSync(file, "utf8")]))
	const reports = reportsOf(rule, fixture, { options: [{ entries: [entry] }], repo: REPO })
	return reports.map(({ file, message }) => `${file}: ${message}`)
}

describe("comb/public-jsdoc's checked entries", () => {
	it("are exactly the entries whose surface lints clean, or every entry once all are", () => {
		const entries = sourceEntries()
		const clean = entries.filter((entry) => reportsThrough(entry).length === 0)
		expect(setting()).toEqual(clean.length === entries.length ? "error" : ["error", { entries: clean }])
	})
})
