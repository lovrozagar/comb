/**
 * Fakes of the two binaries a SQLite apply runs. `atlas migrate hash` writes a sum over the
 * directory's files, `atlas schema diff` answers as told. wrangler runs on an in-memory SQLite
 * (node:sqlite) the way the D1 commands comb calls behave: `d1 execute --json --command` returns
 * rows, `--file` runs all-or-nothing, and `d1 migrations apply` runs each unapplied file with its
 * row in the migrations table, in wrangler's order.
 */
import { createHash } from "node:crypto"
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { localD1Path } from "../../migrate/core/d1-binding.ts"
import { wranglerOrder } from "../../migrate/core/plan-apply.ts"
import type { Run, RunResult } from "../../migrate/core/process.ts"

const ok = (stdout = ""): RunResult => ({ code: 0, stderr: "", stdout })
const fail = (stderr: string): RunResult => ({ code: 1, stderr, stdout: "" })

/** The atlas.sum the fake writes: one hash over every .sql file's name and text */
export function writeSum(dir: string): void {
	const files = readdirSync(dir)
		.filter((file) => file.endsWith(".sql"))
		.sort()
	const digest = createHash("sha256")
	for (const file of files) digest.update(`${file}\n${readFileSync(join(dir, file), "utf8")}\n`)
	writeFileSync(join(dir, "atlas.sum"), `h1:${digest.digest("hex")}\n`)
}

/** The file wrangler keeps `binding`'s local database in under `configDir`, made as a first --local command makes it */
export function localD1(configDir: string, binding: Parameters<typeof localD1Path>[1]): void {
	const path = localD1Path(configDir, binding)
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(path, "")
}

type AtlasAnswers = { schemaDiff?: RunResult | undefined }

/** atlas: `migrate hash` writes the fake sum; `schema diff` answers `answers.schemaDiff`, synced by default */
export function fakeAtlas(answers: AtlasAnswers = {}): Run {
	return (_cmd, args) => {
		if (args[1] === "hash") {
			writeSum((args[args.indexOf("--dir") + 1] as string).replace("file://", ""))
			return ok()
		}
		return answers.schemaDiff ?? ok("Schemas are synced, no changes to be made.\n")
	}
}

type D1Options = {
	/** the database's migrations directory, which `d1 migrations apply` reads */
	dir: string
	/** `d1 migrations apply` exits 0 having applied nothing, as a declined prompt does */
	declines?: boolean | undefined
	table?: string | undefined
}

export type FakeD1 = Run & { calls: string[][]; db: DatabaseSync }

/** wrangler on an in-memory D1, with atlas faked alongside */
export function fakeD1(options: D1Options, atlas: Run = fakeAtlas()): FakeD1 {
	const db = new DatabaseSync(":memory:")
	const calls: string[][] = []
	const table = options.table ?? "d1_migrations"
	const migrationsApply = (): RunResult => {
		if (options.declines === true) return ok("About to apply… continue? no")
		const applied = new Set(
			db
				.prepare(`SELECT name FROM "${table}"`)
				.all()
				.map((row) => String(row["name"])),
		)
		const files = wranglerOrder(readdirSync(options.dir).filter((name) => name.endsWith(".sql")))
		for (const name of files.filter((file) => !applied.has(file))) {
			try {
				db.exec(
					`BEGIN;\n${readFileSync(join(options.dir, name), "utf8")}\n;INSERT INTO "${table}" (name) VALUES ('${name}');\nCOMMIT;`,
				)
			} catch (error) {
				db.exec("ROLLBACK")
				return fail(`Migration ${name} failed: ${(error as Error).message}`)
			}
		}
		return ok()
	}
	const run: Run = (cmd, args) => {
		calls.push([cmd, ...args])
		if (cmd === "atlas") return atlas(cmd, args)
		if (args[1] === "migrations") return migrationsApply()
		const command = args.find((arg) => arg.startsWith("--command="))
		if (command !== undefined) {
			try {
				return ok(JSON.stringify([{ results: db.prepare(command.slice("--command=".length)).all() }]))
			} catch (error) {
				return fail((error as Error).message)
			}
		}
		const file = args.find((arg) => arg.startsWith("--file=")) as string
		try {
			db.exec(`BEGIN;\n${readFileSync(file.slice("--file=".length), "utf8")}\nCOMMIT;`)
			return ok("[]")
		} catch (error) {
			db.exec("ROLLBACK")
			return fail((error as Error).message)
		}
	}
	return Object.assign(run, { calls, db })
}
