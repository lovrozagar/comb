/**
 * A consumer's tsc reads every DTO comb writes, so every zod builder codegen emits, with the params it
 * passes, must be one zod's types take: z.iso.date({ pattern }) ran, and zod's types refuse it. One
 * project holds a column for each rule the DTO generators write, on both dialects, and tsc reads it
 * under a consumer's strict flags; a builder the generators name that the project never writes fails
 * here, so the next rule is typechecked too.
 */
import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { codegen, generatedFiles, project, read, typecheck, useProjects } from "../support/codegen-project.ts"

useProjects()

const PG_TABLES = `import { bigint, bit, boolean, cidr, date, doublePrecision, inet, integer, interval, json, jsonb, macaddr, macaddr8, numeric, pgEnum, pgTable, real, text, time, timestamp, uuid, varchar } from "drizzle-orm/pg-core"
import { c } from "@lovrozagar/comb/pg/columns"
import { settings } from "./schemas.ts"
export const mood = pgEnum("mood", ["ok", "sad"])
export const kinds = pgTable("kinds", {
	id: c.id("knd"),
	d: date("d"),
	ts: timestamp("ts", { mode: "string" }),
	ts3: timestamp("ts3", { mode: "string", precision: 3 }),
	tz: timestamp("tz", { mode: "string", withTimezone: true }),
	tz0: timestamp("tz0", { mode: "string", withTimezone: true, precision: 0 }),
	t: time("t"),
	t2: time("t2", { precision: 2 }),
	tt: time("tt", { withTimezone: true }),
	n52: numeric("n52", { precision: 5, scale: 2 }),
	nn: numeric("nn"),
	nr: numeric("nr", { mode: "number", precision: 5, scale: 2 }),
	b: bigint("b", { mode: "string" }),
	bn: bigint("bn", { mode: "number" }),
	r: real("r"),
	dp: doublePrecision("dp"),
	ip: inet("ip"),
	net: cidr("net"),
	mac: macaddr("mac"),
	mac8: macaddr8("mac8"),
	bits: bit("bits", { dimensions: 3 }),
	iv: interval("iv"),
	ivDays: interval("iv_days", { fields: "day" }),
	ivWhole: interval("iv_whole", { fields: "second", precision: 0 }),
	u: uuid("u"),
	v: varchar("v", { length: 3 }),
	flag: boolean("flag"),
	count: integer("count"),
	feeling: mood("feeling"),
	tags: text("tags").array(),
	grid: integer("grid").array("[][]"),
	plain: json("plain"),
	doc: jsonb("doc"),
	prefs: c.json("prefs", settings),
	state: c.enum("state", ["done", "queued"], { initial: "queued", terminal: ["done"] }).notNull(),
	name: c.text("name", { name: true }),
	mail: c.text("mail", { email: true }),
	site: c.text("site", { url: true }),
	code: c.text("code", { pattern: "/^[a-z]+$/" }),
	score: c.real("score"),
	level: c.integer("level", { min: 1, max: 9 }),
	on: c.boolean("on"),
	at: c.timestamp("at"),
	createdAt: c.createdAt("createdAt"),
	updatedAt: c.updatedAt("updatedAt"),
})
export const child = pgTable("child", { id: c.id("chd"), kindsId: c.ref("kinds_id").references(() => kinds.id) })
`

const SQLITE_TABLES = `import { sqliteTable } from "drizzle-orm/sqlite-core"
import { c } from "@lovrozagar/comb/sqlite/columns"
import { settings } from "./schemas.ts"
export const note = sqliteTable("note", {
	id: c.id("not"),
	body: c.text("body"),
	mail: c.text("mail", { email: true }),
	site: c.text("site", { url: true }),
	prefs: c.json("prefs", settings),
	state: c.enum("state", ["done", "queued"], { initial: "queued", terminal: ["done"] }).notNull(),
	score: c.real("score"),
	on: c.boolean("on"),
	createdAt: c.createdAt("createdAt"),
	deletedAt: c.deletedAt("deletedAt"),
})
`

const SCHEMAS = 'import * as z from "zod"\nexport const settings = z.object({ theme: z.string() })\n'

/*
 * tsconfig.strict.json's flags past the ones `typecheck` already sets, but isolatedDeclarations: a
 * generated schema's type is zod's inference, which no DTO file writes out (TS9010, TS9013)
 */
const STRICT = { allowJs: false, erasableSyntaxOnly: true }

const DTOS = path.join(import.meta.dirname, "../../../src/codegen/generators/dtos")

/** The zod builders the DTO generators name in what they write, such as z.string( or z.iso.date( */
const builders = (): string[] => {
	const named = fs
		.readdirSync(DTOS)
		.filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
		.flatMap((file) => [...fs.readFileSync(path.join(DTOS, file), "utf8").matchAll(/\bz\.(?:iso\.)?[A-Za-z0-9]+\(/g)])
		.map((match) => match[0])
	return [...new Set(named)].sort()
}

describe("every zod builder comb's DTOs call, as a consumer's tsc reads it", () => {
	it("typechecks the DTOs of a column of every kind, on Postgres and SQLite, each builder written", async () => {
		const dir = project({
			"comb.config.ts": `export default { databases: {
	core: { tables: "./src/db/db.core.tables.ts" },
	support: { tables: "./src/pg/db.support.tables.ts", dialect: "postgres" },
} }\n`,
			"src/db/db.core.tables.ts": SQLITE_TABLES,
			"src/db/schemas.ts": SCHEMAS,
			"src/pg/db.support.tables.ts": PG_TABLES,
			"src/pg/schemas.ts": SCHEMAS,
		})
		await codegen(dir)
		const written = generatedFiles(dir)
			.filter((file) => file.endsWith(".ts"))
			.map((file) => read(dir, file))
			.join("\n")
		expect(builders().filter((builder) => !written.includes(builder))).toEqual([])
		/* the consumer's strict flags, then typecheck:strict's on top of them: the ones comb holds its own source to */
		for (const options of [{}, STRICT, { ...STRICT, lib: ["es2022"], target: "es2022" }])
			expect(
				typecheck(dir, [], options)
					.split("\n")
					.filter((line) => line.includes(".gen.ts")),
			).toEqual([])
	}, 240_000)
})
