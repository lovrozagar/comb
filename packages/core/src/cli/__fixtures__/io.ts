/** A CliIo for tests: it records what the CLI writes, and runs processes through `run` if given. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Run, RunResult } from "../../migrate/core/process.ts"
import type { LiveObjects } from "../../migrate/core/pg-live-types.ts"
import type { CliIo } from "../output.ts"
import { noLive } from "../../migrate/__fixtures__/live-objects.ts"

export type TestIo = CliIo & { errors: string[]; outputs: string[] }

/* a Postgres baseline's catalog read reaches no database: its schema holds no function or trigger */
const readPgObjects = async (): Promise<LiveObjects> => ({
	...noLive(),
	policies: new Map(),
	relations: new Map(),
	routines: new Map(),
	triggers: new Map(),
})

/* nor does the history's replay on dev (P5 of r19): it leaves what the faked database holds */
const replayPgHistory = async (_target: unknown, { targetUser }: { targetUser: string }): Promise<LiveObjects> => ({
	...(await readPgObjects()),
	user: targetUser,
})

/* every optional peer is comb's own devDependency, found as comb resolves it, wherever the project is */
const locatePeer = (peer: string): string => import.meta.resolve(peer)

/* the Atlas comb is tested against, which a test's faked Atlas stands for: its version read spawns nothing */
const readAtlasVersion = (): RunResult =>
	ok("atlas version v1.3.0\nhttps://github.com/ariga/atlas/releases/tag/v1.3.0\n")

/* nor does the dev database a non-public schema is created on (P12): Atlas, faked, needs none */
const readyPgDev = async (): Promise<void> => undefined

export function makeIo(cwd: string, run?: Run, confirm?: CliIo["confirm"]): TestIo {
	const outputs: string[] = []
	const errors: string[] = []
	return {
		confirm,
		cwd,
		err: (line) => errors.push(line),
		errors,
		locatePeer,
		out: (line) => outputs.push(line),
		outputs,
		readAtlasVersion,
		readPgObjects,
		readyPgDev,
		replayPgHistory,
		run,
	}
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
