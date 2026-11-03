/**
 * The copy of a SQLite-family target the proof runs on (proof-run.ts): the target's live schema, read
 * in one SELECT, created in a scratch database with seed rows that show any change (proof-seed.ts),
 * tables and indexes first, then the seed, then triggers and views, as the database has them. The
 * same copy, as statements, is what a D1 file is proven on in D1's own engine (d1-engine.ts, SD1 of r22).
 */
import { isMirror, seedMirrors } from "./proof-mirror.ts"
import { type LocalDb, openScratch, type ScratchDb, type ScratchEngine } from "../drivers/local-db.ts"
import type { Connection } from "../types.ts"
import { keyGroups, quote, seedTables } from "./proof-seed.ts"
import { asciiFold } from "./sql-code.ts"
import { isVectorIndexSql, vectorShadows } from "./vector-index.ts"

/** One object of the live schema, and the table it belongs to (sqlite_master's tbl_name) */
type LiveObject = { name: string; sql: string; table: string; type: string }

// lookup-table: the shadow tables each module makes beside its virtual table, which creating it makes again
const SHADOWS: Readonly<Record<string, readonly string[]>> = {
	fts3: ["content", "docsize", "segdir", "segments", "stat"],
	fts4: ["content", "docsize", "segdir", "segments", "stat"],
	fts5: ["config", "content", "data", "docsize", "idx"],
	geopoly: ["node", "parent", "rowid"],
	rtree: ["node", "parent", "rowid"],
	rtree_i32: ["node", "parent", "rowid"],
	spellfix1: ["vocab"],
}

/** The target's schema, read in one SELECT: SQLite's and D1's own objects left out */
async function liveObjects(conn: Connection, engine: string): Promise<LiveObject[]> {
	const { columns, rows } = await conn.execute(
		`SELECT type, name, sql, tbl_name FROM sqlite_master WHERE sql IS NOT NULL${engine} ORDER BY rowid`,
	)
	const at = (name: string) => columns.indexOf(name)
	return rows.map((row) => ({
		name: String(row[at("name")]),
		sql: String(row[at("sql")]),
		table: String(row[at("tbl_name")]),
		type: String(row[at("type")]),
	}))
}

const isVirtual = (object: LiveObject): boolean => /^CREATE VIRTUAL TABLE\b/i.test(object.sql)

/**
 * The objects the copy creates: every one but those another one makes itself, a virtual table's
 * module's shadow tables, and a vector index's shadow table, its index and libsql's table of vector
 * indexes (SL3 of r22)
 */
function creatable(objects: readonly LiveObject[]): LiveObject[] {
	const shadows = new Set(
		objects.filter(isVirtual).flatMap((object) => {
			/* a CREATE VIRTUAL TABLE names its module */
			const module = (/\bUSING\s+(\w+)/i.exec(object.sql) as RegExpExecArray)[1]?.toLowerCase() as string
			return (SHADOWS[module] ?? []).map((suffix) => asciiFold(`${object.name}_${suffix}`))
		}),
	)
	const made = vectorShadows(
		objects.filter((object) => object.type === "index" && isVectorIndexSql(object.sql)).map(({ name }) => name),
	)
	return objects.filter(
		(object) => !(object.type === "table" && shadows.has(asciiFold(object.name))) && !made.has(asciiFold(object.name)),
	)
}

/** The columns, by lower-case name, a pending file reads with a `json_*` function: the seed holds JSON there */
function jsonColumns(files: ReadonlyArray<{ sql: string }>): Set<string> {
	/* a json_* function's first argument, or the column before a -> or ->> */
	const call = /\bjson\w*\s*\(\s*(?:["`[]?\w+["`\]]?\s*\.\s*)?["`[]?(\w+)/gi
	const arrow = /(?:["`[]?\w+["`\]]?\s*\.\s*)?["`[]?(\w+)["`\]]?\s*->>?/g
	return new Set(
		files.flatMap(({ sql }) =>
			[...sql.matchAll(call), ...sql.matchAll(arrow)].map((match) => asciiFold(match[1] as string)),
		),
	)
}

/** Why a table is unproven when the copy cannot create `object`: none for a view, which holds no rows */
function uncreated(object: LiveObject, message: string): [table: string, why: string] | undefined {
	if (object.type === "view") return undefined
	if (object.type === "trigger")
		return [asciiFold(object.table), `its trigger ${object.name} could not be created: ${message}`]
	return [asciiFold(object.table), `comb could not create it in the copy: ${message}`]
}

/** How a copy is seeded: which seed, and the columns pending files read as JSON; none for a copy of the schema alone */
type Seed = { json: ReadonlySet<string>; variant: number } | undefined

/**
 * The copy: tables and indexes, then the seed, then triggers and views, as the database has them;
 * returns the tables it could not create or seed, or whose trigger it could not create, with why
 */
function buildCopy(db: LocalDb, objects: readonly LiveObject[], seed: Seed): Map<string, string> {
	const unproven = new Map<string, string>()
	const make = (object: LiveObject) => {
		try {
			db.exec(object.sql)
		} catch (error) {
			// reason: what the copy cannot create, nothing proves; its table is listed unproven with why
			const [table, why] = uncreated(object, (error as Error).message) ?? []
			if (table !== undefined && why !== undefined && !unproven.has(table)) unproven.set(table, why)
		}
	}
	const tables = objects.filter((each) => each.type === "table")
	for (const object of [...tables, ...objects.filter((each) => each.type === "index")]) make(object)
	if (seed === undefined) {
		for (const object of objects.filter((each) => each.type === "trigger" || each.type === "view")) make(object)
		return unproven
	}
	const seedable = tables.filter(
		(object) =>
			!unproven.has(asciiFold(object.name)) &&
			(!isVirtual(object) || /\busing fts5\b/i.test(object.sql)) &&
			!isMirror(object),
	)
	for (const object of tables.filter((each) => isVirtual(each) && !seedable.includes(each) && !isMirror(each)))
		unproven.set(asciiFold(object.name), "a virtual table comb does not seed")
	const definitions = new Map(seedable.map((object) => [object.name, object.sql]))
	for (const [table, why] of [...seedTables(db, definitions, seed), ...seedMirrors(db, tables.filter(isMirror))])
		unproven.set(table, why)
	for (const object of objects.filter((each) => each.type === "trigger" || each.type === "view")) make(object)
	return unproven
}

/** One copy of the target: its database, and the tables comb could not seed in it, with why */
type Copy = { db: ScratchDb; unproven: Map<string, string> }

/** A copy of `objects` on `engine`, seeded as `seed` */
async function copyOf(
	objects: readonly LiveObject[],
	seed: NonNullable<Seed>,
	engine: ScratchEngine = "runtime",
): Promise<Copy> {
	const db = await openScratch(engine)
	return { db, unproven: buildCopy(db, objects, seed) }
}

/** The rows of the copy's table `name`, each as an INSERT of its stored columns' values as SQLite quotes them */
function insertsOf(db: LocalDb, name: string): string[] {
	const columns = db
		.all(`PRAGMA main.table_xinfo(${quote(name)})`)
		.filter((row) => row["hidden"] === 0)
		.map((row) => quote(String(row["name"])))
	const values = db.all(
		`SELECT ${columns.map((column) => `quote(${column})`).join(" || ', ' || ")} AS v FROM main.${quote(name)}`,
	)
	return values.map((row) => `INSERT INTO ${quote(name)} (${columns.join(", ")}) VALUES (${String(row["v"])})`)
}

/**
 * The copy the proof runs `files` on, as statements another engine can run: the live schema `objects`' tables and
 * indexes, the seed's rows of each table but a virtual one, then the triggers and views (SD1 of r22). An object
 * the copy could not create is left out, as the proof leaves it out. Rows go parents first, under defer_foreign_keys
 * for a cycle of keys: the seed meets every key, as D1 holds them all (8.4).
 */
async function copyScript(objects: readonly LiveObject[], files: ReadonlyArray<{ sql: string }>): Promise<string[]> {
	const copy = await copyOf(objects, { json: jsonColumns(files), variant: 0 })
	try {
		const made = new Set(copy.db.all("SELECT name FROM main.sqlite_master").map((row) => String(row["name"])))
		const kept = objects.filter((object) => made.has(object.name))
		const of = (...types: string[]) => kept.filter((object) => types.includes(object.type))
		const seeded = of("table")
			.filter((object) => !isVirtual(object))
			.map((object) => object.name)
		const rows = keyGroups(copy.db, seeded)
			.flat()
			.flatMap((name) => insertsOf(copy.db, name))
		/* D1 holds every foreign key on: parents go first, and a cycle's rows meet its keys as the batch commits */
		return [
			"PRAGMA defer_foreign_keys = ON",
			...of("table", "index").map(({ sql }) => sql),
			...rows,
			...of("trigger", "view").map(({ sql }) => sql),
		]
	} finally {
		copy.db.close()
	}
}

export { buildCopy, type Copy, copyOf, copyScript, creatable, isVirtual, jsonColumns, type LiveObject, liveObjects }
