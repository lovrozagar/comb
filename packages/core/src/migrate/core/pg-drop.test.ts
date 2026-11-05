/**
 * What a Postgres DROP … CASCADE drops that the history's facts do not show: each object it names,
 * as the file names it, of every kind a DROP takes, and the column or constraint an ALTER's DROP …
 * CASCADE command drops. pg-held.test.ts holds the warning a VALIDATE after one gives.
 */
import { beforeAll, describe, expect, it } from "vitest"
import { cascaded, commandCascaded } from "./pg-drop.ts"
import type { Node } from "./pg-nodes.ts"
import { loadPostgresParser, parsePostgres } from "./pg-parser.ts"

beforeAll(loadPostgresParser)

/** The one statement of `sql`, by its node */
async function statement(sql: string): Promise<Node> {
	const [stmt] = (await parsePostgres(sql)).stmts as Array<{ stmt: Node }>
	return Object.values((stmt as { stmt: Node }).stmt)[0] as Node
}

// lookup-table: each DROP … CASCADE, and the objects it drops as the file names them
const DROPS: Array<[string, string[]]> = [
	["DROP SEQUENCE public.s, app.t CASCADE", ["s", "app.t"]],
	["DROP SCHEMA app CASCADE", ["app"]],
	["DROP TYPE app.pair, int CASCADE", ["app.pair", "int4"]],
	["DROP FUNCTION app.f(int), g CASCADE", ["app.f", "g"]],
	["DROP OPERATOR + (int, int) CASCADE", ["+"]],
	["DROP CAST (int AS app.pos) CASCADE", ["(int4 AS app.pos)"]],
	["DROP OPERATOR CLASS app.ops USING btree CASCADE", ["app.ops USING btree"]],
	["DROP OPERATOR FAMILY ops USING hash CASCADE", ["ops USING hash"]],
	["DROP TRANSFORM FOR int LANGUAGE sql CASCADE", ["FOR int4 LANGUAGE sql"]],
	["DROP TRIGGER t ON app.orders CASCADE", ["t on app.orders"]],
	["DROP POLICY p ON orders CASCADE", ["p on orders"]],
	["DROP RULE r ON orders CASCADE", ["r on orders"]],
	["DROP SEQUENCE s", []],
	["DROP FUNCTION f() RESTRICT", []],
]

// lookup-table: each ALTER command, and the column or constraint a DROP … CASCADE of it drops
const COMMANDS: Array<[string, string | undefined]> = [
	["ALTER TABLE app.orders DROP COLUMN x CASCADE", "app.orders.x"],
	["ALTER TABLE orders DROP CONSTRAINT k CASCADE", "k on orders"],
	["ALTER TYPE pair DROP ATTRIBUTE z CASCADE", "pair.z"],
	["ALTER TYPE pair ADD ATTRIBUTE z int CASCADE", undefined],
	["ALTER TYPE pair ALTER ATTRIBUTE z TYPE bigint CASCADE", undefined],
	["ALTER TABLE orders DROP COLUMN x", undefined],
	["ALTER TABLE orders ADD COLUMN y int", undefined],
]

describe("what a DROP … CASCADE drops that no fact shows", () => {
	it.each(DROPS)("%s drops what depends on %j", async (sql, objects) => {
		expect(cascaded(await statement(sql), "public")).toEqual(objects)
	})

	it.each(COMMANDS)("%s drops what depends on %s", async (sql, object) => {
		const node = await statement(sql)
		const [cmd] = (node["cmds"] as Array<{ AlterTableCmd: Node }>).map((each) => each.AlterTableCmd)
		expect(commandCascaded(node, cmd as Node, "public")).toBe(object)
	})
})
