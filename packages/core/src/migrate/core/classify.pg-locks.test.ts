/**
 * M81 of the 0.13.0 round: a constraint that builds its index in place (ADD PRIMARY KEY, UNIQUE or
 * EXCLUDE without USING INDEX) holds an ACCESS EXCLUSIVE lock on a table the file did not create,
 * which blocks reads too; SET EXPRESSION recomputes every stored value of its column, under the
 * same lock. Probed on Postgres 17 in the round's lock repro.
 */
import { describe, expect, it } from "vitest"
import { classifyMigration } from "./classify.ts"
import { extractSchema } from "./schema.ts"

const HISTORY = "CREATE TABLE t (id int, email text, a int, g int GENERATED ALWAYS AS (a * 2) STORED);"

/** `later`'s rating after HISTORY, both read as Postgres */
function rate(later: string) {
	const before = extractSchema(HISTORY, undefined, "postgres")
	return classifyMigration(later, { before, dialect: "postgres" })
}

describe("a constraint that builds its index under an exclusive lock (M81)", () => {
	it("warns of ADD PRIMARY KEY and UNIQUE without USING INDEX, pointing to the concurrent index", () => {
		for (const later of ["ALTER TABLE t ADD PRIMARY KEY (id);", "ALTER TABLE t ADD CONSTRAINT u UNIQUE (email);"]) {
			expect(rate(later).lockWarnings.join(" ")).toContain(
				"locks t against reads and writes while it builds its index; build it first with CREATE UNIQUE INDEX CONCURRENTLY, then ADD … USING INDEX",
			)
		}
	})

	it("warns of ADD EXCLUDE, which no concurrent index can back", () => {
		expect(rate("ALTER TABLE t ADD EXCLUDE USING btree (id WITH =);").lockWarnings.join(" ")).toContain(
			"locks t against reads and writes while it builds its index",
		)
	})

	it("warns of none for USING INDEX, or on a table the file creates", () => {
		expect(rate("ALTER TABLE t ADD CONSTRAINT u UNIQUE USING INDEX t_email;").lockWarnings).toEqual([])
		expect(rate("CREATE TABLE n (id int);\nALTER TABLE n ADD PRIMARY KEY (id);").lockWarnings).toEqual([])
	})
})

/* P6 of the 0.14.1 review: an added column's inline primary key or unique builds its index as ADD CONSTRAINT does */
describe("an added column's inline primary key or unique", () => {
	it("warns of the index it builds on a table the file did not create, and of none on one it does", () => {
		for (const later of ["ALTER TABLE t ADD COLUMN k serial PRIMARY KEY;", "ALTER TABLE t ADD COLUMN u text UNIQUE;"])
			expect(rate(later).lockWarnings.join(" "), later).toContain(
				"locks t against reads and writes while it builds its index",
			)
		expect(rate("CREATE TABLE n (id int);\nALTER TABLE n ADD COLUMN u text UNIQUE;").lockWarnings).toEqual([])
	})
})

describe("SET EXPRESSION (M81)", () => {
	it("is cautious, recomputing every stored value of its column, with the rewrite lock warning", () => {
		const rated = rate("ALTER TABLE t ALTER COLUMN g SET EXPRESSION AS (a * 3);")
		expect(rated.safety).toBe("cautious")
		expect(rated.cautiousStatements.join(" ")).toContain("recomputes every stored value of g")
		expect(rated.lockWarnings.join(" ")).toContain("rewrites or scans the table under an exclusive lock")
	})

	it("fires a history's table_rewrite event trigger, as Postgres rewrites the table", () => {
		const before = extractSchema(
			`${HISTORY}\nCREATE FUNCTION f() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN END $$;\nCREATE EVENT TRIGGER e ON table_rewrite EXECUTE FUNCTION f();`,
			undefined,
			"postgres",
		)
		const rated = classifyMigration("ALTER TABLE t ALTER COLUMN g SET EXPRESSION AS (a * 3);", {
			before,
			dialect: "postgres",
		})
		expect(rated.unsafeStatements.join(" ")).toContain("runs event trigger e")
	})
})

/* P1 of the 0.15.0 review: each holds ACCESS EXCLUSIVE on what it reads (probed on Postgres 17, d5-attach-partition-lock.ts) */
describe("ATTACH PARTITION, REFRESH MATERIALIZED VIEW and LOCK", () => {
	it("warns that ATTACH PARTITION scans the partition under an exclusive lock, with the NOT VALID CHECK recipe", () => {
		const rated = rate("ALTER TABLE ev ATTACH PARTITION ev_old FOR VALUES FROM ('2020-01-01') TO ('2021-01-01');")
		expect(rated.safety).toBe("safe")
		expect(rated.lockWarnings).toEqual([
			expect.stringMatching(
				/^ALTER TABLE ev ATTACH PARTITION ev_old .* \(scans ev_old under an exclusive lock to check its bound; add a CHECK constraint matching the bound NOT VALID, VALIDATE it, then ATTACH\)$/,
			),
		])
	})

	it("warns that a refresh that is not concurrent holds an exclusive lock, and of none for a concurrent one", () => {
		expect(rate("REFRESH MATERIALIZED VIEW mv;").lockWarnings).toEqual([
			"REFRESH MATERIALIZED VIEW mv (holds an exclusive lock while it runs)",
		])
		expect(rate("REFRESH MATERIALIZED VIEW CONCURRENTLY mv;").lockWarnings).toEqual([])
	})

	it.each([
		["LOCK t;", "locks t against reads and writes"],
		["LOCK TABLE t, s.u IN ACCESS EXCLUSIVE MODE;", "locks t, s.u against reads and writes"],
		["LOCK TABLE t IN EXCLUSIVE MODE;", "locks t against writes"],
		["LOCK TABLE t IN SHARE MODE;", "locks t against writes"],
	])("warns what %j blocks, until the file's transaction ends", (later, blocks) => {
		expect(rate(later).lockWarnings).toEqual([`${later.slice(0, -1)} (${blocks} until the file's transaction ends)`])
	})

	it("warns of none for a lock that blocks neither reads nor writes", () => {
		expect(rate("LOCK TABLE t IN ROW EXCLUSIVE MODE;").lockWarnings).toEqual([])
	})
})
