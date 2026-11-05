/**
 * comb's lock warnings held to Postgres's own locks (PA8, PA9 and PA10 of r22b). Each case runs a file
 * as Atlas does, in one transaction after the files before it, reads what that transaction holds from
 * pg_locks, and rates the same file: comb warns of a statement where the lock it scans or builds
 * under blocks the table, and names its sibling where the lock does not.
 */
import pg from "pg"
import { beforeAll, describe, expect, it } from "vitest"
import { classifyMigration } from "../../../src/migrate/core/classify.ts"
import { loadPostgresParser } from "../../../src/migrate/core/pg-parser.ts"
import { extractSchema } from "../../../src/migrate/core/schema.ts"
import { withScratchDb } from "../support/pg.ts"
import { heldBy } from "../support/pg-locks.ts"

beforeAll(loadPostgresParser)

const HISTORY = [
	"CREATE TABLE users (id int PRIMARY KEY, n int);",
	"CREATE TABLE orders (id int, user_id int);",
	"CREATE DOMAIN posint AS int;",
	"CREATE TABLE dm (id int, v posint);",
	"CREATE TABLE ev (id int NOT NULL, at date NOT NULL) PARTITION BY RANGE (at);",
	"CREATE TABLE ev_old PARTITION OF ev FOR VALUES FROM ('2020-01-01') TO ('2021-01-01');",
].join("\n")

/** What the transaction of `file` holds blocked by table at its end, the `earlier` files committed after HISTORY */
const heldIn = (url: string, file: string, earlier: readonly string[] = []) => heldBy(url, [HISTORY, ...earlier], file)

/** comb's lock warnings on `file`, the `earlier` files read into its history */
const warned = (file: string, earlier: readonly string[] = []): string[] =>
	classifyMigration(file, {
		before: extractSchema([HISTORY, ...earlier].join("\n"), undefined, "postgres"),
		dialect: "postgres",
	}).lockWarnings

/** Postgres's locks at the end of `file` beside comb's warnings on it */
const both = async (url: string, file: string, earlier: readonly string[] = []) => ({
	held: await heldIn(url, file, earlier),
	warned: warned(file, earlier),
})

const CHECK_ADD = "ALTER TABLE users ADD CONSTRAINT pos CHECK (n > 0) NOT VALID;"
const CHECK_VALIDATE = "ALTER TABLE users VALIDATE CONSTRAINT pos;"
const FK_ADD = "ALTER TABLE orders ADD CONSTRAINT fk FOREIGN KEY (user_id) REFERENCES users (id) NOT VALID;"
const FK_VALIDATE = "ALTER TABLE orders VALIDATE CONSTRAINT fk;"
const HELD = "those locks last to the file's COMMIT; validate in a later file"

describe("a NOT VALID ADD and its VALIDATE on Postgres 17 (PA8; sibling: the two-file NOT VALID shape)", () => {
	it("warns of a CHECK's VALIDATE in the ADD's file, which scans while the transaction blocks reads", async () => {
		await withScratchDb(async (url) => {
			expect(await both(url, `${CHECK_ADD}\n${CHECK_VALIDATE}\n`)).toEqual({
				held: { users: "reads and writes" },
				warned: [
					`${CHECK_VALIDATE.slice(0, -1)} (scans users while this file holds it locked against reads and writes; ${HELD})`,
				],
			})
		})
	}, 60_000)

	it("warns of a foreign key's VALIDATE in the ADD's file, which scans while both tables' writes wait", async () => {
		await withScratchDb(async (url) => {
			expect(await both(url, `${FK_ADD}\n${FK_VALIDATE}\n`)).toEqual({
				held: { orders: "writes", users: "writes" },
				warned: [
					`${FK_VALIDATE.slice(0, -1)} (scans orders while this file holds orders and users locked against writes; ${HELD})`,
				],
			})
		})
	}, 60_000)

	it("warns of neither VALIDATE in a later file, which blocks no read or write", async () => {
		await withScratchDb(async (url) => {
			expect(await both(url, `${CHECK_VALIDATE}\n${FK_VALIDATE}\n`, [CHECK_ADD, FK_ADD])).toEqual({
				held: {},
				warned: [],
			})
		})
	}, 60_000)
})

describe("a domain's VALIDATE on Postgres 17 (PA9; sibling: the table CHECK's VALIDATE)", () => {
	const DOMAIN_ADD = "ALTER DOMAIN posint ADD CONSTRAINT pos CHECK (VALUE > 0) NOT VALID;"
	const DOMAIN_VALIDATE = "ALTER DOMAIN posint VALIDATE CONSTRAINT pos;"

	it("warns of a domain's VALIDATE in a later file, which blocks writes to each table holding the domain", async () => {
		await withScratchDb(async (url) => {
			expect(await both(url, `${DOMAIN_VALIDATE}\n`, [DOMAIN_ADD])).toEqual({
				held: { dm: "writes" },
				warned: [
					`${DOMAIN_VALIDATE.slice(0, -1)} (scans every column of domain posint, and blocks writes to each table that holds one while it scans)`,
				],
			})
		})
	}, 60_000)

	it("warns of no table CHECK's VALIDATE in a later file, which blocks nothing", async () => {
		await withScratchDb(async (url) => {
			expect(await both(url, `${CHECK_VALIDATE}\n`, [CHECK_ADD])).toEqual({ held: {}, warned: [] })
		})
	}, 60_000)
})

/** comb's recipe for an index on partitioned ev, which CREATE INDEX CONCURRENTLY refuses */
const PARTITIONED_RECIPE =
	"ev is partitioned, which CREATE INDEX CONCURRENTLY refuses: create it ON ONLY ev, then CREATE INDEX CONCURRENTLY on each partition in its own -- atlas:txmode none file, then ALTER INDEX … ATTACH PARTITION each to it"

describe("an index on a partitioned table on Postgres 17 (PA10; sibling: ON ONLY and the primary key or unique constraint)", () => {
	it("warns of a plain CREATE INDEX, which blocks writes to each partition while it builds, with the partitioned recipe", async () => {
		await withScratchDb(async (url) => {
			const file = "CREATE INDEX ev_id ON ev (id);\n"
			expect(await both(url, file)).toEqual({
				held: { ev: "writes", ev_old: "writes" },
				warned: [
					`CREATE INDEX ev_id ON ev (id) (blocks writes to ev and its partitions while it builds; ${PARTITIONED_RECIPE})`,
				],
			})
		})
	}, 60_000)

	it("warns of no CREATE INDEX ON ONLY, which locks no partition and builds nothing", async () => {
		await withScratchDb(async (url) => {
			expect(await both(url, "CREATE INDEX ev_o ON ONLY ev (id);\n")).toEqual({ held: { ev: "writes" }, warned: [] })
		})
	}, 60_000)

	it("warns of a primary key, which locks ev against reads and its partitions against writes, with the partitions' route", async () => {
		await withScratchDb(async (url) => {
			const { held, warned: notes } = await both(url, "ALTER TABLE ev ADD PRIMARY KEY (id, at);\n")
			expect(held).toEqual({ ev: "reads and writes", ev_old: "writes" })
			expect(notes).toEqual([
				expect.stringContaining(
					"(locks ev against reads and writes, and its partitions against writes, while it builds its index; ev is partitioned, which ADD … USING INDEX refuses: add it to ONLY ev,",
				),
			])
		})
	}, 60_000)

	it("warns of neither end of that route: ONLY ev builds nothing and locks no partition, and the attach scans nothing", async () => {
		/* the attach holds the partition's index ACCESS EXCLUSIVE, which a query of ev_old opens, but builds nothing under it */
		/* the partition's own concurrent build, and its instant USING INDEX, stand in HISTORY's place here */
		const only = "ALTER TABLE ONLY ev ADD CONSTRAINT ev_pkey PRIMARY KEY (id, at);"
		const partition = [
			"CREATE UNIQUE INDEX ev_old_k ON ev_old (id, at);",
			"ALTER TABLE ev_old ADD CONSTRAINT ev_old_k PRIMARY KEY USING INDEX ev_old_k;",
		]
		await withScratchDb(async (url) => {
			expect(await both(url, `${only}\n`)).toEqual({ held: { ev: "reads and writes" }, warned: [] })
		})
		await withScratchDb(async (url) => {
			expect(await both(url, "ALTER INDEX ev_pkey ATTACH PARTITION ev_old_k;\n", [only, ...partition])).toEqual({
				held: { ev_old: "reads and writes" },
				warned: [],
			})
		})
	}, 60_000)
})

/**
 * The indexes the refusals name: ev's own, a unique one ONLY on ev made valid by its partition's,
 * which ADD … USING INDEX checks before it refuses the partitioned table, and one of the partition's own
 */
const PREAMBLE = [
	"CREATE INDEX ev_at ON ev (at);",
	"CREATE UNIQUE INDEX ev_only ON ONLY ev (id, at);",
	"CREATE UNIQUE INDEX ev_old_u ON ev_old (id, at);",
	"ALTER INDEX ev_only ATTACH PARTITION ev_old_u;",
	"CREATE UNIQUE INDEX ev_old_p ON ev_old (id);",
].join("\n")

/** Postgres's refusal of `file`, sent bare after HISTORY and PREAMBLE */
async function refusedBy(url: string, file: string): Promise<string> {
	const client = new pg.Client({ connectionString: url })
	await client.connect()
	try {
		await client.query(`${HISTORY}\n${PREAMBLE}`)
		return await client.query(file).then(
			() => "ran",
			(error: Error) => error.message,
		)
	} finally {
		await client.end()
	}
}

/** comb's refusal of `file` in a txmode none file after PREAMBLE, as Postgres runs it */
function combRefusal(file: string): string {
	try {
		warned(`-- atlas:txmode none\n\n${file}`, [PREAMBLE])
		return "ran"
	} catch (error) {
		return (error as Error).message
	}
}

describe("what Postgres refuses on a partitioned table on Postgres 17 (PA10; sibling: the partition's own)", () => {
	it.each([
		["CREATE INDEX CONCURRENTLY ev_c ON ev (id)", 'cannot create index on partitioned table "ev" concurrently'],
		["DROP INDEX CONCURRENTLY ev_at", 'cannot drop partitioned index "ev_at" concurrently'],
		[
			"ALTER TABLE ev ADD CONSTRAINT ev_k UNIQUE USING INDEX ev_only",
			"ALTER TABLE / ADD CONSTRAINT USING INDEX is not supported on partitioned tables",
		],
	])(
		"refuses %s in any file, quoting Postgres's refusal",
		async (file, refusal) => {
			await withScratchDb(async (url) => {
				expect(await refusedBy(url, file)).toBe(refusal)
				expect(combRefusal(`${file};`)).toContain(`("${refusal}")`)
			})
		},
		60_000,
	)

	it("runs a partition's own USING INDEX, which comb refuses not", async () => {
		const file = "ALTER TABLE ev_old ADD CONSTRAINT ev_old_k UNIQUE USING INDEX ev_old_p"
		await withScratchDb(async (url) => {
			expect(await refusedBy(url, file)).toBe("ran")
			expect(combRefusal(`${file};`)).toBe("ran")
		})
	}, 60_000)
})
