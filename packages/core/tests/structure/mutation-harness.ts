/**
 * The mutation check: a guard is load-bearing only if the adversarial suite goes red without it.
 * For each registered guard, run tests/integration/security with that guard disabled
 * (COMB_MUTANT=<id>, applied by the suite through vi.doMock) and require a failing run; with every
 * guard in place the suite must pass.
 *
 *     bun packages/core/tests/structure/mutation-harness.ts
 */
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/d1"
import { CombError } from "../../src/error.ts"
import type { SqliteErrorRead } from "../../src/sqlite/read-error.ts"
import { openD1Session } from "../../src/sqlite/d1/session.ts"
import { shardMap } from "../../src/sqlite/d1/sharding/shard-map.ts"

export type Guard = {
	/** what the suite must catch once this guard is gone */
	catches: string
	/** the module's exports with the guard switched off, built from its real exports */
	disable(original: Record<string, unknown>): Record<string, unknown>
	id: string
	/** path of the module that holds the guard, relative to packages/core */
	module: string
}

type Fn = (...args: never[]) => unknown

/** The engine read the wrapper's own text would give: what classifying on user-controlled text means */
function readFromWrapperText(read: (error: unknown) => SqliteErrorRead | null) {
	return (error: unknown): SqliteErrorRead | null => {
		const text = error instanceof Error ? error.message : String(error)
		const code = /SQLITE_CONSTRAINT_[A-Z]+/.exec(text)?.[0]
		return code === undefined ? read(error) : { code, message: text, query: undefined }
	}
}

/** A router whose first allocation is a plain insert: two racers both insert, one conflicts */
function plainInsertRouter(Base: new (...args: never[]) => object) {
	return class extends Base {
		async allocate(orgId: string, deps: { coreDb: never }): Promise<unknown> {
			const db = drizzle(openD1Session(deps.coreDb).client)
			const shardId = await (this as unknown as { pickShard(db: unknown): Promise<number> }).pickShard(db)
			await db.insert(shardMap).values({ driver: "d1", org_id: orgId, shard_id: shardId, target: String(shardId) })
			const row = await db.select().from(shardMap).where(eq(shardMap.org_id, orgId)).get()
			return (this as unknown as { rowToMapping(row: unknown): unknown }).rowToMapping(row)
		}
	}
}

export const GUARDS: readonly Guard[] = [
	{
		catches: "a filter on a field nothing resolves dropped, answering with the unfiltered list",
		disable: (original) => {
			const filterToSQL = original["filterToSQL"] as (...args: unknown[]) => unknown
			return {
				filterToSQL: (...args: unknown[]) => {
					try {
						return filterToSQL(...args)
					} catch (error) {
						if (error instanceof CombError && error.errorKey === "filter_not_wired") return null
						throw error
					}
				},
			}
		},
		id: "filter-fail-closed",
		module: "src/query/sqlite/executor.ts",
	},
	{
		catches: "a hand-built filter or order, which no schema checked, reaching any column",
		disable: () => ({ assertSchemaParsed: () => undefined }),
		id: "schema-parsed",
		module: "src/query/trusted.ts",
	},
	{
		catches: "a cursor value of the wrong type bound into the keyset predicate",
		disable: () => ({ assertCursorFits: () => undefined }),
		id: "cursor-value-type",
		module: "src/query/sqlite/cursor-fit.ts",
	},
	{
		catches: "a cursor the client wrote itself, whose sort value probes a column it cannot select",
		/* the seal skipped: a cursor's bytes taken as its payload, as an unsealed cursor would be */
		disable: () => ({
			openSealed: (cursor: string) => {
				try {
					return Uint8Array.from(atob(cursor.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0))
				} catch {
					return null
				}
			},
		}),
		id: "cursor-seal",
		module: "src/query/cursor-seal.ts",
	},
	{
		catches: "an identifier holding a double quote spliced into raw SQL unescaped",
		disable: () => ({ quoteIdent: (name: string) => `"${name}"` }),
		id: "raw-sql-quoting",
		module: "src/query/sqlite/identifier.ts",
	},
	{
		catches: "a failed query classified as a constraint violation because its params say so",
		disable: (original) => ({
			readSqliteError: readFromWrapperText(original["readSqliteError"] as (error: unknown) => SqliteErrorRead | null),
		}),
		id: "constraint-classification",
		module: "src/sqlite/read-error.ts",
	},
	{
		catches: "a bad query reported as a transient 503 because its text or params mention a transient word",
		disable: (original) => {
			const d1ErrorHandler = original["d1ErrorHandler"] as Fn
			return {
				d1ErrorHandler: (error: unknown, maps: never) => {
					const text = error instanceof Error ? `${error.message} ${String(error.cause)}` : String(error)
					if (/reset|network|unavailable/i.test(text)) {
						throw new CombError({ errorKey: "database_unavailable", source: error, status: "service_unavailable" })
					}
					return d1ErrorHandler(error as never, maps)
				},
			}
		},
		id: "transient-classification",
		module: "src/sqlite/d1/error-handler.ts",
	},
	{
		catches: "two first requests for one org racing to insert its mapping, one failing",
		disable: (original) => ({ ShardRouter: plainInsertRouter(original["ShardRouter"] as new () => object) }),
		id: "shard-upsert",
		module: "src/sqlite/d1/sharding/router.ts",
	},
]

const CORE = resolve(import.meta.dirname, "../..")
const SUITE = "tests/integration/security"
const VITEST = join(dirname(createRequire(import.meta.url).resolve("vitest/package.json")), "vitest.mjs")

/** The guard COMB_MUTANT names; undefined for the plain suite; a typo throws */
export function guardNamed(id: string | undefined): Guard | undefined {
	if (id === undefined || id === "") return undefined
	const guard = GUARDS.find((g) => g.id === id)
	if (guard === undefined) throw new Error(`unknown guard "${id}"; known: ${GUARDS.map((g) => g.id).join(", ")}`)
	return guard
}

/** The absolute path a suite mocks for a guard */
export const guardModule = (guard: Guard): string => resolve(CORE, guard.module)

/** The adversarial suite's exit status, with `mutant` disabled when given */
export function runSuite(mutant: string | undefined): number {
	const env = { ...process.env, COMB_MUTANT: mutant ?? "" }
	const run = spawnSync(process.execPath, [VITEST, "run", SUITE], { cwd: CORE, encoding: "utf8", env })
	return run.status ?? 1
}

/** The guards whose removal left the suite green */
export function survivors(results: ReadonlyArray<{ id: string; status: number }>): string[] {
	return results.filter((r) => r.status === 0).map((r) => r.id)
}

function main(): number {
	if (runSuite(undefined) !== 0) {
		process.stderr.write("mutation: the adversarial suite fails with every guard in place\n")
		return 1
	}
	const results = GUARDS.map((g) => ({ id: g.id, status: runSuite(g.id) }))
	for (const r of results) process.stdout.write(`${r.status === 0 ? "SURVIVED" : "killed  "} ${r.id}\n`)
	const left = survivors(results)
	if (left.length > 0) process.stderr.write(`mutation: no case catches ${left.join(", ")}\n`)
	return left.length === 0 ? 0 : 1
}

if (import.meta.main) process.exit(main())
