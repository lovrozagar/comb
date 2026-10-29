/**
 * Plan 13's 4.6: `comb codegen` run in a consumer installed from the packed tarball, under bun and
 * under each node of COMB_CODEGEN_NODES (colon-separated paths; `node` on PATH when unset), writes
 * the same bytes everywhere. Codegen loads the tables module at runtime, so each runtime's module
 * loading (bun natively, node through comb's hooks) must read the tables alike.
 */
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { pathToFileURL } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { ok, pack, run, type Stage, stage } from "./stage.ts"

const TABLES = `import { sql } from "drizzle-orm"
import { check, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { c } from "@lovrozagar/comb/sqlite/columns"
import { STATES } from "@app/enums"
import { prefsSchema } from "./schemas.ts"

const NAME = { max: 64, trim: true } as const
export const user = sqliteTable("user", {
	id: c.id("usr"),
	email: c.text("email", { email: true, max: 254 }).notNull().unique(),
	name: c.text("name", NAME).notNull(),
	state: c.enum("state", STATES, { initial: "draft", terminal: ["live"] }).notNull(),
	prefs: c.json("prefs", prefsSchema, { maxBytes: 1024 }),
	note: text("note", { length: 20 }),
	createdAt: c.createdAt("created_at"),
	updatedAt: c.updatedAt("updated_at"),
}, (t) => [uniqueIndex("user_email_lower").on(sql\`lower(\${t.email})\`), check("user_name_size", sql\`length(\${t.name}) <= 64\`)])
export const membership = sqliteTable("membership", {
	userId: c.ref("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
	role: c.text("role").notNull(),
}, (t) => [primaryKey({ columns: [t.userId, t.role] })])
`

const PG_TABLES = `import { integer, pgEnum, pgTable, text, varchar } from "drizzle-orm/pg-core"
import { c } from "@lovrozagar/comb/pg/columns"
export const mood = pgEnum("mood", ["ok", "sad"])
export const ticket = pgTable("ticket", { id: c.integer("id").primaryKey().generatedAlwaysAsIdentity(), code: varchar("code", { length: 3 }).notNull(), feeling: mood("feeling"), tags: text("tags").array(), grid: integer("grid").array("[][]") })
`

const FILES = {
	"comb.config.ts": `export default { databases: {
	core: { tables: "./src/db/db.core.tables.ts" },
	support: { tables: "./src/pg/db.support.tables.ts", dialect: "postgres" },
} }\n`,
	"src/db/db.core.tables.ts": TABLES,
	"src/db/schemas.ts": `import * as z from "zod"\nexport const prefsSchema = z.object({ theme: z.string() })\n`,
	"src/lib/enums.ts": `export const STATES = ["draft", "live"] as const\n`,
	"src/pg/db.support.tables.ts": PG_TABLES,
	"tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "@app/*": ["./src/lib/*"] } } }),
}

/** The nodes to run codegen under: COMB_CODEGEN_NODES, else the `node` on PATH */
const NODES = (process.env["COMB_CODEGEN_NODES"] ?? "node").split(":").filter(Boolean)

let app: Stage
let manifest: string
beforeAll(() => {
	app = stage(pack(), "all", FILES)
	manifest = readFileSync(join(app.dir, "package.json"), "utf8")
}, 600_000)
afterAll(() => app?.dispose())

/** Every file codegen wrote, by path, its record and package.json included; then the app as it was */
function written(): Record<string, string> {
	const files = readdirSync(app.dir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && !entry.parentPath.includes("node_modules"))
		.map((entry) => join(entry.parentPath, entry.name))
		.filter((file) => file.includes(".gen."))
	const out = Object.fromEntries(files.map((file) => [relative(app.dir, file), readFileSync(file, "utf8")]))
	out["package.json"] = readFileSync(join(app.dir, "package.json"), "utf8")
	for (const file of files) rmSync(file)
	writeFileSync(join(app.dir, "package.json"), manifest)
	return out
}

/** `comb codegen` under node `bin`: comb's own hooks load its TypeScript, as they load the child's */
function underNode(bin: string): string {
	const core = join(app.dir, "node_modules/@lovrozagar/comb/src")
	const hooks = pathToFileURL(join(core, "codegen/runtime/node-hooks.mjs")).href
	const cli = pathToFileURL(join(core, "cli/index.ts")).href
	const script = `const { processIo, runCli } = await import(${JSON.stringify(cli)}); process.exitCode = await runCli(["codegen"], processIo())`
	return ok(
		run(app.dir, bin, [
			"--experimental-import-meta-resolve",
			"--disable-warning=ExperimentalWarning",
			"--import",
			`data:text/javascript,import{install}from${JSON.stringify(hooks)};install()`,
			"--input-type=module",
			"-e",
			script,
		]),
		`codegen under ${bin}`,
	)
}

describe("comb codegen in a consumer, on every runtime (4.6)", () => {
	it("writes the same bytes under bun and every node", () => {
		ok(run(app.dir, "bun", ["node_modules/.bin/comb", "codegen"]), "codegen under bun")
		const bun = written()
		expect(Object.keys(bun)).toEqual(
			expect.arrayContaining(["src/db/dtos/user/db.core.user.gen.ts", "src/pg/dtos/ticket/db.support.ticket.gen.ts"]),
		)
		for (const node of NODES) {
			const version = ok(run(app.dir, node, ["--version"]), `${node} --version`).trim()
			underNode(node)
			expect(written(), `node ${version}`).toEqual(bun)
		}
	}, 600_000)
})
