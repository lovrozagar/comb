/**
 * The reference-cycle scenario of the 0.8.0 review (R1): a and b reference each other, a also its
 * parent, and a rebuild of the parent arrives with no `PRAGMA defer_foreign_keys`. The guard
 * empties a and b and refills a before b, so a's key to b fails at once unless the guard defers
 * the checks itself. One scenario, run on each engine.
 */
import { guardRebuilds } from "../../../src/migrate/core/rebuild-guard.ts"
import { extractSchema } from "../../../src/migrate/core/schema.ts"
import type { Engine } from "./rebuild-guard.ts"

export const CYCLE_BASE = `CREATE TABLE parent (id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE a (id INTEGER PRIMARY KEY, p_id INTEGER REFERENCES parent(id) ON DELETE CASCADE, b_id INTEGER REFERENCES b(id) ON DELETE CASCADE, v TEXT);
CREATE TABLE b (id INTEGER PRIMARY KEY, a_id INTEGER REFERENCES a(id) ON DELETE SET NULL, v TEXT);
`

const SEED = `INSERT INTO parent VALUES (1, 'p1'), (2, 'p2');
INSERT INTO a VALUES (1, 1, NULL, 'a1'), (2, 2, NULL, 'a2');
INSERT INTO b VALUES (1, 1, 'b1'), (2, 2, 'b2');
UPDATE a SET b_id = id;
`

/* a rebuild of the parent as Atlas writes it, without the foreign-key pragmas */
const REBUILD = `CREATE TABLE new_parent (id INTEGER PRIMARY KEY, name TEXT NOT NULL DEFAULT '');
INSERT INTO new_parent (id, name) SELECT id, name FROM parent;
DROP TABLE parent;
ALTER TABLE new_parent RENAME TO parent;
`

const snapshot = async (engine: Engine) => ({
	a: await engine.rows("SELECT * FROM a ORDER BY id"),
	b: await engine.rows("SELECT * FROM b ORDER BY id"),
	parent: await engine.rows("SELECT * FROM parent ORDER BY id"),
})

/** The scenario on `engine`: the rows before and after the guarded rebuild, and the foreign-key check after */
export async function runCycleScenario(engine: Engine): Promise<Record<string, unknown>> {
	await engine.apply(CYCLE_BASE)
	await engine.run(SEED)
	const before = await snapshot(engine)
	await engine.apply(guardRebuilds(REBUILD, extractSchema(CYCLE_BASE)))
	return { after: await snapshot(engine), before, foreignKeyCheck: await engine.rows("PRAGMA foreign_key_check") }
}
