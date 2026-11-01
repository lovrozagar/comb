import { beforeAll, describe, expect, it } from "vitest"
import { emptyFacts, type Node } from "./pg-nodes.ts"
import { domainOf, followDomain, followDomainName } from "./pg-domains.ts"
import { loadPostgresParser, postgresParser } from "./pg-parser.ts"

beforeAll(() => loadPostgresParser())

/** The facts `sql`'s statements leave, each followed as a domain statement and as a domain's name */
function follow(sql: string, facts = emptyFacts("public")) {
	const followed = (postgresParser().parseSync(sql).stmts as Array<{ stmt: Node }>).map(({ stmt }) => {
		const [type, node] = Object.entries(stmt)[0] as [string, Node]
		followDomainName(type, node, facts)
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
		expect([...facts.domains].filter(([, domain]) => domain.fill !== undefined).map(([key]) => key)).toEqual(["b", "c"])
	})

	it("keeps the function a domain's CHECK runs, and gives it to every column the domain already types", () => {
		const before = emptyFacts("public")
		before.columnTypes.set("t", new Map([["x", { collation: undefined, dims: 0, mods: [], type: "d" }]]))
		const { facts } = follow(
			"CREATE DOMAIN d AS int; ALTER DOMAIN d SET NOT NULL; ALTER DOMAIN d ADD CHECK (VALUE > 0); ALTER DOMAIN d ADD CHECK (ok(VALUE)); ALTER DOMAIN d ADD CHECK (other(VALUE));",
			before,
		)
		expect([domainOf("d", facts)?.runs, facts.code.get("t")]).toEqual(["ok", "ok"])
	})

	it("keeps one NOT NULL however often it is set, reads VALIDATE as no change, and skips a domain it never saw", () => {
		const { facts } = follow(
			"CREATE DOMAIN d AS int NOT NULL; ALTER DOMAIN d SET NOT NULL; ALTER DOMAIN d VALIDATE CONSTRAINT d_not_null; ALTER DOMAIN other SET NOT NULL; CREATE DOMAIN k AS int NOT NULL CHECK (VALUE > 0); ALTER DOMAIN k DROP NOT NULL;",
		)
		expect([...facts.domains.keys()]).toEqual(["d", "k"])
		expect([...(facts.domains.get("d")?.constraints.keys() ?? [])]).toEqual(["d_not_null"])
		expect([...(facts.domains.get("k")?.constraints.keys() ?? [])]).toEqual(["k_check"])
	})

	it("gives a CHECK added to a base to every column of a domain over it", () => {
		const before = emptyFacts("public")
		before.columnTypes.set("t", new Map([["x", { collation: undefined, dims: 0, mods: [], type: "b" }]]))
		const { facts } = follow(
			"CREATE DOMAIN a AS int; CREATE DOMAIN b AS a; ALTER DOMAIN a ADD CHECK (ok(VALUE));",
			before,
		)
		expect([domainOf("b", facts)?.runs, facts.code.get("t")]).toEqual(["ok", "ok"])
	})
})

/* P10 of r19: a domain's record follows its RENAME, SET SCHEMA and DROP, and its constraints' RENAME */
describe("followDomainName", () => {
	it("moves a renamed or moved domain's record, the domains over it and its columns, and leaves a type that is no domain", () => {
		const before = emptyFacts("public")
		before.columnTypes.set("t", new Map([["x", { collation: undefined, dims: 0, mods: [], type: "a" }]]))
		const { facts } = follow(
			"CREATE DOMAIN a AS int; CREATE DOMAIN b AS a; ALTER DOMAIN a RENAME TO c; ALTER DOMAIN c SET SCHEMA s; ALTER TYPE mood RENAME TO feeling;",
			before,
		)
		expect([...facts.domains.keys()]).toEqual(["b", "s.c"])
		expect([facts.domains.get("b")?.base, facts.columnTypes.get("t")?.get("x")?.type]).toEqual(["s.c", "s.c"])
	})

	it("drops a domain with every domain over it, and leaves a dropped type that is no domain", () => {
		const { facts } = follow(
			"CREATE DOMAIN a AS int; CREATE DOMAIN b AS a; CREATE DOMAIN c AS b; CREATE DOMAIN e AS int; DROP TYPE mood; DROP DOMAIN a CASCADE;",
		)
		expect([...facts.domains.keys()]).toEqual(["e"])
	})

	it("renames a constraint it knows, and leaves one it does not or one of a domain it never saw", () => {
		const { facts } = follow(
			"CREATE DOMAIN d AS int CHECK (VALUE > 0); ALTER DOMAIN d RENAME CONSTRAINT d_check TO c; ALTER DOMAIN d RENAME CONSTRAINT nope TO z; ALTER DOMAIN other RENAME CONSTRAINT y TO z;",
		)
		expect([...(facts.domains.get("d")?.constraints.keys() ?? [])]).toEqual(["c"])
	})
})
