/**
 * PA10 of r22b: an index on a partitioned table, probed on Postgres 17
 * (.tmp/grunt/r22b/migrate-pg-atlas/lock/partitioned-index-recipe.log, .tmp/grunt/p21/areas/pa/pa10/probe.log).
 * CREATE INDEX CONCURRENTLY refuses a partitioned table, so the route is an index ON ONLY the parent,
 * which builds nothing and locks no partition, each partition's index built concurrently, and each
 * attached to it. Postgres refuses CONCURRENTLY there in any file.
 */
import { beforeAll, describe, expect, it } from "vitest"
import { classifyMigration } from "./classify.ts"
import { loadPostgresParser } from "./pg-parser.ts"
import { extractSchema } from "./schema.ts"

beforeAll(loadPostgresParser)

const HISTORY = `CREATE TABLE t (id int);
CREATE TABLE ev (id int NOT NULL, at date NOT NULL) PARTITION BY RANGE (at);
CREATE TABLE ev_a PARTITION OF ev FOR VALUES FROM ('2020-01-01') TO ('2021-01-01');
CREATE INDEX ev_at ON ev (at);
`

/** `later`'s rating after HISTORY and `more`, all read as Postgres */
const rate = (later: string, more = "") =>
	classifyMigration(later, { before: extractSchema(`${HISTORY}${more}`, undefined, "postgres"), dialect: "postgres" })

/** comb's recipe for an index on partitioned `table` */
const RECIPE = (table: string) =>
	`${table} is partitioned, which CREATE INDEX CONCURRENTLY refuses: create it ON ONLY ${table}, then CREATE INDEX CONCURRENTLY on each partition in its own -- atlas:txmode none file, then ALTER INDEX … ATTACH PARTITION each to it`

const PLAIN = "use CREATE INDEX CONCURRENTLY in its own -- atlas:txmode none file"

describe("a CREATE INDEX on a partitioned table (PA10; sibling: ON ONLY and a plain table's)", () => {
	it("warns of the build on each partition with the partitioned recipe, a unique index's too", () => {
		expect(
			rate("CREATE INDEX ev_id ON ev (id);\nCREATE UNIQUE INDEX ev_u ON public.ev (id, at);").lockWarnings,
		).toEqual([
			`CREATE INDEX ev_id ON ev (id) (blocks writes to ev and its partitions while it builds; ${RECIPE("ev")})`,
			`CREATE UNIQUE INDEX ev_u ON public.ev (id, at) (blocks writes to public.ev and its partitions while it builds; ${RECIPE("public.ev")})`,
		])
	})

	it("warns of none ON ONLY a partitioned table, which builds nothing, and of a plain table's ON ONLY as before", () => {
		expect(rate("CREATE INDEX ev_o ON ONLY ev (id);").lockWarnings).toEqual([])
		expect(rate("CREATE INDEX t_o ON ONLY t (id);").lockWarnings).toEqual([
			`CREATE INDEX t_o ON ONLY t (id) (blocks writes to t while it builds; ${PLAIN})`,
		])
	})

	it("gives a partition's index and a table partitioned by an earlier file the recipe each holds", () => {
		expect(rate("CREATE INDEX ev_a_id ON ev_a (id);").lockWarnings).toEqual([
			`CREATE INDEX ev_a_id ON ev_a (id) (blocks writes to ev_a while it builds; ${PLAIN})`,
		])
		const more = "CREATE TABLE q (a int) PARTITION BY LIST (a);\n"
		expect(rate("CREATE INDEX q_a ON q (a);", more).lockWarnings).toEqual([
			`CREATE INDEX q_a ON q (a) (blocks writes to q and its partitions while it builds; ${RECIPE("q")})`,
		])
	})
})

/** comb's route to a primary key or unique constraint on partitioned `table` */
const KEY_ROUTE = (table: string) =>
	`add it to ONLY ${table}, which builds nothing and locks no partition, then build each partition's unique index with CREATE UNIQUE INDEX CONCURRENTLY in its own -- atlas:txmode none file, add each partition's constraint USING INDEX, then ALTER INDEX … ATTACH PARTITION each to ${table}'s`

const TXMODE_NONE = "-- atlas:txmode none\n\n"

describe("a key on a partitioned table (PA10; sibling: a plain table's key and an exclusion constraint)", () => {
	it("warns of a primary key or unique constraint with the partitions' route, inline with its column too", () => {
		expect(
			rate(
				"ALTER TABLE ev ADD PRIMARY KEY (id, at);\nALTER TABLE ev ADD COLUMN k int, ADD CONSTRAINT ev_k UNIQUE (k, at);\nALTER TABLE ev ADD COLUMN j int UNIQUE;",
			).lockWarnings,
		).toEqual([
			`ALTER TABLE ev ADD PRIMARY KEY (id, at) (locks ev against reads and writes, and its partitions against writes, while it builds its index; ev is partitioned, which ADD … USING INDEX refuses: ${KEY_ROUTE("ev")})`,
			`ALTER TABLE ev ADD COLUMN k int, ADD CONSTRAINT ev_k UNIQUE (k, at) (locks ev against reads and writes, and its partitions against writes, while it builds its index; ev is partitioned, which ADD … USING INDEX refuses: ${KEY_ROUTE("ev")})`,
			`ALTER TABLE ev ADD COLUMN j int UNIQUE (locks ev against reads and writes, and its partitions against writes, while it builds its index; ev is partitioned, which ADD … USING INDEX refuses: add the column, then ${KEY_ROUTE("ev")})`,
		])
	})

	it("warns of no key ON ONLY a partitioned table, which builds nothing, but of a plain table's ONLY", () => {
		expect(
			rate("ALTER TABLE ONLY ev ADD PRIMARY KEY (id, at);\nALTER TABLE ONLY ev ADD CONSTRAINT ev_k UNIQUE (id, at);")
				.lockWarnings,
		).toEqual([])
		expect(rate("ALTER TABLE ONLY t ADD PRIMARY KEY (id);").lockWarnings).toEqual([
			"ALTER TABLE ONLY t ADD PRIMARY KEY (id) (locks t against reads and writes while it builds its index; build it first with CREATE UNIQUE INDEX CONCURRENTLY, then ADD … USING INDEX)",
		])
	})

	it("gives a plain table's key the USING INDEX route, and a partitioned exclusion constraint none", () => {
		expect(rate("ALTER TABLE t ADD PRIMARY KEY (id);").lockWarnings).toEqual([
			"ALTER TABLE t ADD PRIMARY KEY (id) (locks t against reads and writes while it builds its index; build it first with CREATE UNIQUE INDEX CONCURRENTLY, then ADD … USING INDEX)",
		])
		expect(rate("ALTER TABLE ev ADD EXCLUDE USING btree (id WITH =, at WITH =);").lockWarnings).toEqual([
			"ALTER TABLE ev ADD EXCLUDE USING btree (id WITH =, at WITH =) (locks ev against reads and writes, and its partitions against writes, while it builds its index)",
		])
	})
})

describe("what Postgres refuses on a partitioned table in any file (PA10; sibling: the same on a plain table)", () => {
	it("refuses CREATE INDEX CONCURRENTLY on a partitioned table, ON ONLY too, with the partitioned route", () => {
		for (const sql of [
			"CREATE INDEX CONCURRENTLY ev_c ON ev (id);",
			"CREATE INDEX CONCURRENTLY ev_c ON ONLY public.ev (id);",
		]) {
			const table = sql.includes("public.ev") ? "public.ev" : "ev"
			expect(() => rate(`${TXMODE_NONE}${sql}`)).toThrow(
				`${sql.slice(0, -1)}: Postgres refuses CREATE INDEX CONCURRENTLY on partitioned ${table} ("cannot create index on partitioned table "ev" concurrently"); create it ON ONLY ${table}, then`,
			)
		}
		expect(() => rate("CREATE INDEX CONCURRENTLY ev_c ON ev (id);")).toThrow(
			"Postgres refuses CREATE INDEX CONCURRENTLY",
		)
	})

	it("refuses DROP INDEX CONCURRENTLY of a partitioned index, and ADD … USING INDEX on a partitioned table", () => {
		expect(() =>
			rate(`${TXMODE_NONE}DROP INDEX CONCURRENTLY t_x, public.ev_at;`, "CREATE INDEX t_x ON t (id);\n"),
		).toThrow(
			`DROP INDEX CONCURRENTLY t_x, public.ev_at: Postgres refuses DROP INDEX CONCURRENTLY of partitioned index public.ev_at ("cannot drop partitioned index "ev_at" concurrently"); drop it without CONCURRENTLY`,
		)
		expect(() => rate("ALTER TABLE ev ADD COLUMN k int, ADD CONSTRAINT ev_k UNIQUE USING INDEX ev_a_k;")).toThrow(
			`ALTER TABLE ev ADD COLUMN k int, ADD CONSTRAINT ev_k UNIQUE USING INDEX ev_a_k: Postgres refuses ADD … USING INDEX on partitioned ev ("ALTER TABLE / ADD CONSTRAINT USING INDEX is not supported on partitioned tables"); ${KEY_ROUTE("ev")}`,
		)
	})

	it("refuses none of them on a plain table or a partition, nor what Postgres runs on a partitioned one", () => {
		const more =
			"CREATE INDEX t_x ON t (id);\nCREATE UNIQUE INDEX t_u ON t (id);\nCREATE UNIQUE INDEX ev_a_u ON ev_a (id, at);\n"
		for (const sql of [
			`${TXMODE_NONE}CREATE INDEX CONCURRENTLY t_c ON t (id);`,
			`${TXMODE_NONE}DROP INDEX CONCURRENTLY t_x;`,
			`${TXMODE_NONE}DROP TABLE t;`,
			"ALTER TABLE t ADD CONSTRAINT t_k UNIQUE USING INDEX t_u;",
			"ALTER TABLE ev_a ADD CONSTRAINT ev_a_k UNIQUE USING INDEX ev_a_u;",
			"DROP INDEX ev_at;",
			"ALTER TABLE ev ALTER COLUMN id SET DEFAULT 0;",
			"CREATE INDEX ev_o ON ONLY ev (id);",
		])
			expect(() => rate(sql, more)).not.toThrow()
	})
})
