/// <reference types="bun-types" />
/**
 * The cascade-rebuild scenario (tests/integration/support/rebuild-guard.ts) on bun:sqlite, with
 * foreign keys on: every row a rebuilt table's references reach survives Atlas's DROP TABLE.
 */
import { Database } from "bun:sqlite"
import { spawnSync } from "node:child_process"
import { describe, expect, it } from "bun:test"
import { type Engine, history, runScenario, SOUND } from "../integration/support/rebuild-guard.ts"

/** bun:sqlite in memory with foreign keys on; a file applies in one transaction */
function bunEngine(): Engine & { close(): void } {
	const db = new Database(":memory:")
	db.exec("PRAGMA foreign_keys = ON")
	return {
		apply: async (sql) => void db.exec(`BEGIN;\n${sql}\nCOMMIT;`),
		close: () => db.close(),
		rows: async (sql) => db.query(sql).all() as Array<Record<string, unknown>>,
		run: async (sql) => void db.exec(sql),
	}
}

/* CI installs Atlas, so there a missing binary fails this suite rather than skipping it */
const atlas = spawnSync("atlas", ["version"]).status === 0 || (process.env["CI"] ?? "") !== ""

describe.if(atlas)("the guard around Atlas's rebuild of a referenced table, on bun:sqlite", () => {
	it("keeps every row, key, rowid, sequence and index entry through a rebuild of the parent, then of parent and child", async () => {
		const engine = bunEngine()
		const h = history()
		try {
			const { both, parent } = await runScenario(engine, h)
			for (const outcome of [parent, both]) {
				expect(outcome.after).toEqual(outcome.before)
				expect(outcome.sound).toEqual(SOUND)
				expect(outcome.safety).toBe("cautious")
			}
		} finally {
			engine.close()
			h.dispose()
		}
	}, 60_000)
})
