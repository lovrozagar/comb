/**
 * bun:sqlite under vitest, which runs on Node and cannot load it: Node's own SQLite with the three
 * methods bun's Database adds (run, transaction, close), so a driver's SQL still runs on a real
 * engine. A test mocks the module with it: `vi.mock("bun:sqlite", () => import(".../bun-sqlite-node.ts"))`.
 */
import { DatabaseSync } from "node:sqlite"

export class Database extends DatabaseSync {
	run(sql: string, params: unknown[] = []) {
		return this.prepare(sql).run(...(params as never[]))
	}

	/* bun's statements hold their table until finalized; Node's have nothing to free */
	override prepare(sql: string) {
		return Object.assign(super.prepare(sql), { finalize: () => undefined })
	}

	transaction(work: () => void) {
		return () => {
			this.exec("BEGIN")
			try {
				work()
				this.exec("COMMIT")
			} catch (error) {
				this.exec("ROLLBACK")
				throw error
			}
		}
	}
}
