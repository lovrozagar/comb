/// <reference types="bun-types" />
/**
 * The cascade-rebuild scenario (tests/integration/support/rebuild-guard.ts) on bun:sqlite, with
 * foreign keys on: every row a rebuilt table's references reach survives Atlas's DROP TABLE.
 */
import { Database } from "bun:sqlite"
import { spawnSync } from "node:child_process"
import { describe, expect, it } from "bun:test"
import { type Engine, history, runScenario, SOUND } from "../integration/support/rebuild-guard.ts"
import { runCycleScenario } from "../integration/support/cycle-guard.ts"
import { ROWID_NOTES, runRowidScenario } from "../integration/support/rowid-guard.ts"

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

	it("keeps every rowid of a text-keyed table and its children through a rebuild, but a 100-column table's without a rowid key, naming it", async () => {
		const engine = bunEngine()
		const h = history(undefined, "")
		try {
			const { t, w100 } = await runRowidScenario(engine, h)
			for (const outcome of [t, w100]) {
				expect(outcome.sound).toEqual(SOUND)
				expect(outcome.after).toEqual(outcome.before)
			}
			expect(t.notes).toEqual(ROWID_NOTES.t)
			expect(w100.notes).toEqual(ROWID_NOTES.w100)
		} finally {
			engine.close()
			h.dispose()
		}
	}, 60_000)

	it("keeps the rows of a reference cycle the rebuilt table reaches, the file deferring no key (R1)", async () => {
		const engine = bunEngine()
		try {
			const { after, before, foreignKeyCheck } = await runCycleScenario(engine)
			expect(after).toEqual(before)
			expect(foreignKeyCheck).toEqual([])
		} finally {
			engine.close()
		}
	}, 60_000)
})
