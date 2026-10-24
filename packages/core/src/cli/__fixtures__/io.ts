/** A CliIo for tests: it records what the CLI writes, and runs processes through `run` if given. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Run, RunResult } from "../../migrate/core/process.ts"
import type { CliIo } from "../output.ts"

export type TestIo = CliIo & { errors: string[]; outputs: string[] }

export function makeIo(cwd: string, run?: Run, confirm?: CliIo["confirm"]): TestIo {
	const outputs: string[] = []
	const errors: string[] = []
	return { confirm, cwd, err: (line) => errors.push(line), errors, out: (line) => outputs.push(line), outputs, run }
}

/**
 * Fresh project directories under `base`; `clean` removes every one made so far (register it with
 * afterEach). A codegen test makes them inside the package, so the tables it loads import drizzle and comb
 */
export function projects(base: string = tmpdir()): { clean: () => void; make: () => string } {
	const dirs: string[] = []
	return {
		clean: () => {
			for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true })
		},
		make: () => {
			const dir = mkdtempSync(join(base, "comb-cli-"))
			dirs.push(dir)
			return dir
		},
	}
}

export const ok = (stdout = ""): RunResult => ({ code: 0, stderr: "", stdout })

/** A tables file the analyzer reads and validates: an id prefix (entities) and an enum (enum checks) */
export function writeTables(dir: string, name = "db.core.tables.ts"): string {
	const file = join(dir, name)
	writeFileSync(
		file,
		`import { sqliteTable } from "drizzle-orm/sqlite-core"
import { c } from "@lovrozagar/comb/sqlite/columns"
export const post = sqliteTable("post", {
	id: c.id("pst"),
	title: c.text("title").notNull(),
	status: c.enum("status", ["draft", "live"]).notNull(),
	views: c.integer("views"),
})
`,
	)
	return file
}
