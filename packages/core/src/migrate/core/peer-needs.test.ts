import { describe, expect, it } from "vitest"
import { ATLAS, DIFF, FTS, needsOf, PARSE, PEERS, WRANGLER } from "./peer-needs.ts"

/** The peers a row names, in order */
const peersOf = (needs: ReadonlyArray<{ peer: string }>): string[] => needs.map(({ peer }) => peer)

/* PA5, KC6 and PA22 of r22: Atlas is needed where a command runs it, as the README's lists say */
describe("PEERS: where Atlas is needed (PA5, KC6 + PA22; sibling: the npm peers' rows)", () => {
	it("needs Atlas for diff, check and apply everywhere, baseline but on D1, and status on Postgres alone", () => {
		for (const [provider, commands] of Object.entries(PEERS)) {
			for (const command of ["apply", "check", "diff"] as const)
				expect(commands[command], `${provider} ${command}`).toContain(ATLAS)
			expect(commands.baseline?.includes(ATLAS) ?? false, `${provider} baseline`).toBe(provider !== "d1")
			expect(commands.status?.includes(ATLAS) ?? false, `${provider} status`).toBe(provider === "postgres")
		}
		expect(PEERS.d1.baseline).toEqual([WRANGLER])
	})
})

/* KC3 of r22: a SQLite diff that declares FTS loads its tables file through ts-morph */
describe("needsOf: a diff that declares FTS (KC3; sibling: drizzle-kit's row)", () => {
	it("adds ts-morph after drizzle-kit to a SQLite-family diff that declares FTS, and to nothing else", () => {
		expect(needsOf("diff", "libsql", true)).toEqual([DIFF, FTS, ATLAS])
		expect(peersOf(needsOf("diff", "d1", true))).toEqual(["drizzle-kit", "ts-morph", "atlas"])
		expect(needsOf("diff", "libsql", false)).toBe(PEERS.libsql.diff)
		expect(needsOf("check", "turso", true)).toBe(PEERS.turso.check)
		/* Postgres has no FTS of comb's */
		expect(needsOf("diff", "postgres", true)).toEqual([PARSE, DIFF, ATLAS])
	})

	it("is no need for a command a provider's row leaves out", () => {
		expect(needsOf("status", "bun-sqlite", true)).toEqual([])
	})
})
