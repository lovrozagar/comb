import { beforeAll, describe, expect, it } from "vitest"
import { extractSchema } from "./schema.ts"
import { emptyFacts, type Node } from "./pg-nodes.ts"
import { loadPostgresParser, parsePostgres } from "./pg-parser.ts"
import { followTree } from "./pg-history.ts"
import { fileEnds } from "./pg-split.ts"
import { forgetTemps, resolveTemps, type Temps } from "./pg-temps.ts"

beforeAll(loadPostgresParser)

/** Each statement of `sql` resolved and followed in turn, as one file: each one's top node, and the temps left */
function resolved(sql: string, temps: Temps = new Map()): { nodes: Node[]; temps: Temps } {
	const facts = emptyFacts("public")
	const nodes = (parsePostgres(sql).stmts as unknown[]).map((raw) => {
		const tree = resolveTemps([raw], temps, facts.indexes)
		followTree(tree, facts)
		const [only] = tree as Array<{ stmt: Record<string, Node> }>
		return Object.values((only as { stmt: Record<string, Node> }).stmt)[0] as Node
	})
	return { nodes, temps }
}

/** A DROP's first name list, as written after resolving */
const dropped = (node: Node): string[] =>
	(((node["objects"] as Node[])[0] as Node)["List"] as { items: Array<{ String: { sval: string } }> }).items.map(
		(item) => item.String.sval,
	)

const schemaOf = (relation: unknown): string | undefined => (relation as { schemaname?: string }).schemaname

describe("resolveTemps: a file's names of its temp relations, as Postgres's search path resolves them (AE2-5 of r22)", () => {
	it("returns the tree itself for a file that has made no temp relation and a statement that makes none", () => {
		const stmts = parsePostgres("ALTER TABLE o ADD COLUMN x int").stmts
		expect(resolveTemps(stmts, new Map(), new Map())).toBe(stmts)
	})

	it("writes a temp relation's later unqualified names pg_temp, and not a CREATE without TEMP of its name", () => {
		const { nodes, temps } = resolved(
			"CREATE TEMP TABLE o (id int); ALTER TABLE o ADD COLUMN x int; ALTER TABLE public.o ADD COLUMN y int; CREATE TABLE o (id int); ALTER TABLE t ADD COLUMN z int",
		)
		expect(nodes.map((node) => schemaOf(node["relation"]))).toEqual([
			"pg_temp",
			"pg_temp",
			"public",
			undefined,
			undefined,
		])
		expect([...temps]).toEqual([["o", "o"]])
	})

	it("makes a table made in pg_temp temporary, and a view that reads a temp relation", () => {
		const { nodes, temps } = resolved(
			"CREATE TABLE pg_temp.o (id int); CREATE VIEW v AS SELECT id FROM o; CREATE VIEW w AS SELECT 1 AS id",
		)
		expect(nodes.map((node) => node["relation"] ?? node["view"])).toMatchObject([
			{ relname: "o", schemaname: "pg_temp" },
			{ relname: "v", relpersistence: "t", schemaname: "pg_temp" },
			{ relname: "w", relpersistence: "p" },
		])
		expect([...temps.keys()]).toEqual(["o", "v"])
	})

	it("follows a temp table's named indexes, renames and drops, and its triggers' tables", () => {
		const { nodes, temps } = resolved(
			[
				"CREATE TEMP TABLE o (id int)",
				"CREATE INDEX i ON o (id)",
				"CREATE INDEX ON o (id)",
				"CREATE INDEX j ON t (id)",
				"ALTER TABLE o RENAME TO p",
				"ALTER INDEX i RENAME TO k",
				"ALTER TABLE p RENAME COLUMN id TO n",
				"DROP TRIGGER x ON p",
				"DROP INDEX k",
				"CREATE INDEX m ON p (n)",
				"DROP SCHEMA s",
				"DROP TABLE pg_temp.p, t",
				"DROP INDEX m",
			].join(";\n"),
		)
		expect(dropped(nodes[7] as Node)).toEqual(["pg_temp", "p", "x"])
		expect(dropped(nodes[8] as Node)).toEqual(["pg_temp", "k"])
		expect(dropped(nodes[12] as Node)).toEqual(["m"])
		expect([...temps]).toEqual([])
	})
})

describe("resolveTemps: a temp relation's renames, as Postgres's search path resolves them (AE2-5 of r22)", () => {
	it("keeps a rename of a pg_temp relation the file did not make", () => {
		const { temps } = resolved("ALTER TABLE pg_temp.q RENAME TO r", new Map([["o", "o"]]))
		expect([...temps]).toEqual([["o", "o"]])
	})

	it("follows the indexes of a temp table renamed, and the one Postgres names, from the facts", () => {
		const { nodes, temps } = resolved(
			"CREATE TEMP TABLE o (id int); CREATE INDEX i ON o (id); ALTER TABLE o RENAME TO p; CREATE INDEX ON p (id); DROP INDEX p_id_idx; DROP INDEX i",
		)
		expect(dropped(nodes[4] as Node)).toEqual(["pg_temp", "p_id_idx"])
		expect(dropped(nodes[5] as Node)).toEqual(["pg_temp", "i"])
		expect([...temps]).toEqual([["p", "p"]])
	})
})

describe("forgetTemps: the facts after a file's session ends", () => {
	it("drops every fact keyed by a temp relation, and every foreign key of one", () => {
		const facts = emptyFacts("public")
		facts.tables.set("pg_temp.o", new Set(["id"]))
		facts.tables.set("o", new Set(["id"]))
		facts.partitioned.add("pg_temp.o")
		const key = { columns: ["id"], name: "k", references: "o", table: "o", to: ["id"] }
		facts.foreignKeys.push(key, { ...key, table: "pg_temp.o" }, { ...key, references: "pg_temp.o", table: "pg_temp.p" })
		forgetTemps(facts)
		expect({ fks: facts.foreignKeys, partitioned: [...facts.partitioned], tables: [...facts.tables.keys()] }).toEqual({
			fks: [key],
			partitioned: [],
			tables: ["o"],
		})
	})
})

describe("fileEnds: where a schema's history files end", () => {
	it("ends each file extractSchema read, and each statement of a history without a record", () => {
		const one = extractSchema("CREATE TABLE a (id int);\nCREATE TABLE b (id int);\n", undefined, "postgres")
		const two = extractSchema("CREATE TABLE c (id int);\n", one, "postgres")
		expect(fileEnds(two)).toEqual([2, 3])
		expect(fileEnds({ statements: ["x", "y"] })).toEqual([1, 2])
	})
})
