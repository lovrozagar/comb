import { beforeAll, describe, expect, it } from "vitest"
import { emptyFacts, type Node } from "./pg-nodes.ts"
import { followDomain } from "./pg-domains.ts"
import { loadPostgresParser, postgresParser } from "./pg-parser.ts"

beforeAll(() => loadPostgresParser())

/** The facts `sql`'s statements leave, each followed as a domain statement */
function follow(sql: string, facts = emptyFacts("public")) {
	const followed = (postgresParser().parseSync(sql).stmts as Array<{ stmt: Node }>).map(({ stmt }) => {
		const [type, node] = Object.entries(stmt)[0] as [string, Node]
		return followDomain(type, node, facts)
	})
	return { facts, followed }
}

describe("followDomain", () => {
	it("keeps a domain's default, its base's when it has none, through SET and DROP DEFAULT", () => {
		const { facts, followed } = follow(
			"CREATE DOMAIN a AS int DEFAULT 1; CREATE DOMAIN b AS a; CREATE DOMAIN c AS int; ALTER DOMAIN c SET DEFAULT 2; ALTER DOMAIN a DROP DEFAULT; CREATE TABLE t (id int);",
		)
		expect(followed).toEqual([true, true, true, true, true, false])
		expect([...facts.domainDefaults.keys()]).toEqual(["b", "c"])
	})

	it("keeps the function a domain's CHECK runs, and gives it to every column the domain already types", () => {
		const before = emptyFacts("public")
		before.columnTypes.set("t", new Map([["x", { collation: undefined, dims: 0, mods: [], type: "d" }]]))
		const { facts } = follow(
			"CREATE DOMAIN d AS int; ALTER DOMAIN d SET NOT NULL; ALTER DOMAIN d ADD CHECK (VALUE > 0); ALTER DOMAIN d ADD CHECK (ok(VALUE)); ALTER DOMAIN d ADD CHECK (other(VALUE));",
			before,
		)
		expect([facts.domains.get("d"), facts.code.get("t")]).toEqual(["ok", "ok"])
	})
})
