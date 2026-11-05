/**
 * libpg-query's JSON leaves out every field at its zero value (proto3's default): a 0 is no number
 * and a false no flag, so `numeric(12, 0)` read its scale as NaN (PA11 of r22b). Every read of a
 * parse node's number or flag field goes through `num` or `flag` (pg-nodes.ts), which read an absent
 * field as its zero. The fields are the ones the parser's types declare a number or a boolean in
 * every node that has them; a name some node declares otherwise (ival, boolval, mode) is read
 * through the same reader by hand, where the node it reads is the scalar's.
 */
import { readdirSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const require = createRequire(import.meta.url)
const types = createRequire(require.resolve("libpg-query/package.json")).resolve("@pgsql/types/types.d.ts")

/** Each field the parser's types declare, and the kinds it is declared as across its nodes */
function declared(): Map<string, Set<string>> {
	const kinds = new Map<string, Set<string>>()
	for (const [, name, type] of readFileSync(types, "utf8").matchAll(/^\s+(\w+)\?: ([^;]+);/gm)) {
		const kind = type === "boolean" || type === "number" ? "scalar" : "other"
		kinds.set(name as string, (kinds.get(name as string) ?? new Set()).add(kind))
	}
	return kinds
}

/* location is the parser's byte offset, which comb never reads */
const SCALARS: ReadonlySet<string> = new Set(
	[...declared()].filter(([name, kinds]) => name !== "location" && !kinds.has("other")).map(([name]) => name),
)

const SRC = join(import.meta.dirname, "../../src")

/*
 * reads of a query's row, not a parse node, whose column shares a parser field's name: a new one
 * fails here until it is named, so this list can hide no parse read
 */
const ROWS: ReadonlySet<string> = new Set([
	"migrate/core/pg-replay-database.ts start", // pg_stat_activity's backend_start
	"migrate/core/pg-replay-held.ts oid", // pg_class's and pg_locks's relation oid
	"migrate/core/pg-server-snapshot.ts row", // the snapshot query's row of each object
	"migrate/core/pg-server-writes.ts row", // the snapshot query's row of each object
	"migrate/core/proof-seed.ts unique", // SQLite's PRAGMA index_list
])

/** Every source file under src, tests aside */
const sources = (): string[] =>
	(readdirSync(SRC, { recursive: true }) as string[]).filter(
		(file) => file.endsWith(".ts") && !file.endsWith(".test.ts") && !file.endsWith(".d.ts"),
	)

/** The name of the call whose whole argument the expression ending just before `end` is, if any */
function callAround(text: string, start: number, end: number): string | undefined {
	if (text[end] !== ")") return undefined
	let depth = 0
	for (let at = start - 1; at >= 0; at--) {
		const char = text[at]
		if (char === ")" || char === "]") depth++
		else if (char === "[") depth--
		else if (char === "(") {
			if (depth === 0) return /(\w+)$/.exec(text.slice(0, at))?.[1]
			depth--
		} else if (depth === 0 && /[,;{}=?:&|!]/.test(char as string)) return undefined
	}
	return undefined
}

/** Each read of a scalar field in src that is no `num(…)` or `flag(…)`'s whole argument */
function bareReads(): string[] {
	return sources().flatMap((file) => {
		const text = readFileSync(join(SRC, file), "utf8")
		return [...text.matchAll(/(?:\?\.)?\["(\w+)"\]/g)]
			.filter(([, name]) => SCALARS.has(name as string) && !ROWS.has(`${file} ${name}`))
			.filter((read) => {
				const call = callAround(text, read.index, read.index + read[0].length)
				return call !== "num" && call !== "flag"
			})
			.map((read) => `${file}:${text.slice(0, read.index).split("\n").length} ${read[1]}`)
	})
}

describe("a parse node's number or flag (PA11 of r22b)", () => {
	it("is read through num or flag, so an absent zero reads as one", () => {
		expect(bareReads()).toEqual([])
	})

	it("knows the parser's number and flag fields", () => {
		expect([...SCALARS]).toEqual(expect.arrayContaining(["concurrent", "inh", "missing_ok", "skip_validation"]))
		expect(SCALARS.has("ival")).toBe(false)
	})
})
