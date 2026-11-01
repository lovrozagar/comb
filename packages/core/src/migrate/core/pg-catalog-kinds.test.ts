import { beforeAll, describe, expect, it } from "vitest"
import { sequenceLabel } from "./pg-catalog-kinds.ts"
import { historyFacts } from "./pg-history.ts"
import { loadPostgresParser } from "./pg-parser.ts"
import { extractSchema } from "./schema.ts"

beforeAll(() => loadPostgresParser())

const factsOf = (sql: string) => historyFacts(extractSchema(sql, undefined, "postgres"), "public")

describe("followKinds (P10 of r18)", () => {
	it("keeps each domain, composite and range type and collation by key, through a rename and a drop", () => {
		const facts =
			factsOf(`CREATE DOMAIN d AS int; CREATE TYPE pair AS (a int); CREATE TYPE span AS RANGE (subtype = int4);
CREATE COLLATION ci (provider = icu, locale = 'und'); CREATE COLLATION gone (provider = icu, locale = 'und');
CREATE TYPE mood AS ENUM ('a'); ALTER DOMAIN d RENAME TO positive; ALTER TYPE pair RENAME TO duo; ALTER TYPE unknown RENAME TO other;
ALTER COLLATION gone RENAME TO went; DROP COLLATION went; DROP TYPE mood; ALTER TABLE IF EXISTS x RENAME TO y;`)
		expect([...facts.kinds]).toEqual([
			["span", "range type"],
			["ci", "collation"],
			["positive", "domain"],
			["duo", "composite type"],
		])
	})

	it("keeps each table's rules through a rename and a drop, and the extensions a history creates and drops", () => {
		const facts = factsOf(`CREATE TABLE t (id int); CREATE RULE a AS ON DELETE TO t DO INSTEAD NOTHING;
CREATE RULE b AS ON UPDATE TO t DO INSTEAD NOTHING; ALTER RULE a ON t RENAME TO kept; ALTER RULE nope ON nowhere RENAME TO x;
DROP RULE b ON t; CREATE EXTENSION citext; CREATE EXTENSION hstore; DROP EXTENSION hstore;`)
		expect([[...(facts.rules.get("t") ?? [])], [...facts.extensions]]).toEqual([["kept"], ["citext"]])
	})

	it("keeps a table's row level security while either flag is on", () => {
		const facts =
			factsOf(`CREATE TABLE t (id int); CREATE TABLE u (id int); ALTER TABLE t ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE t DISABLE ROW LEVEL SECURITY; ALTER TABLE u ENABLE ROW LEVEL SECURITY; ALTER TABLE u DISABLE ROW LEVEL SECURITY, ADD COLUMN v int;`)
		expect([...facts.rls]).toEqual([["t", { enabled: false, forced: true }]])
	})

	it("keeps a sequence's settings through an ALTER, and an IF NOT EXISTS that changes nothing", () => {
		const facts = factsOf(`CREATE SEQUENCE s AS smallint INCREMENT -1 MAXVALUE 99999999999 NO MINVALUE START 0 CYCLE;
CREATE SEQUENCE IF NOT EXISTS s; CREATE SEQUENCE r; ALTER SEQUENCE r INCREMENT 5 MINVALUE 2 NO CYCLE CACHE 10; ALTER SEQUENCE nope START 3;`)
		expect(facts.sequences.get("s")).toEqual({
			as: "int2",
			cycle: true,
			increment: "-1",
			max: "99999999999",
			min: undefined,
			start: "0",
		})
		expect(facts.sequences.get("r")).toEqual({
			as: "int8",
			cycle: false,
			increment: "5",
			max: undefined,
			min: "2",
			start: undefined,
		})
		expect(facts.sequences.has("nope")).toBe(false)
	})
})

describe("sequenceLabel", () => {
	it.each([
		[{}, "start 1, increment 1, min 1, max 9223372036854775807, no cycle"],
		[{ as: "int4", increment: "-2" }, "start -1, increment -2, min -2147483648, max -1, no cycle"],
		[{ as: "int2", cycle: true, min: "5" }, "start 5, increment 1, min 5, max 32767, cycle"],
		[{ as: "money", start: "7" }, "start 7, increment 1, min 1, max 9223372036854775807, no cycle"],
	])("spells %j as the catalog does", (given, label) => {
		const settings = {
			as: "int8",
			cycle: false,
			increment: "1",
			max: undefined,
			min: undefined,
			start: undefined,
			...given,
		}
		expect(sequenceLabel(settings)).toBe(label)
	})
})
