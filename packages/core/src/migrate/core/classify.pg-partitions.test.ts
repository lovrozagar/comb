/**
 * P18, P19 and P20 of r19: what Postgres 17 scans and refuses around foreign keys, partitioned tables
 * and their indexes, probed by pg_stat's seq_scan counters (.tmp/grunt/p18/runs/c8d6982-probe-p43-*.log):
 * - an added column's inline REFERENCES scans nothing while the column is NULL, and both tables once a
 *   default fills it;
 * - Postgres refuses a NOT VALID foreign key on a partitioned table; a valid one scans every partition,
 *   unless each partition already holds it validated, which its own NOT VALID and VALIDATE give;
 * - ATTACH … DEFAULT scans the partition for rows another partition's bound takes, unless a validated
 *   CHECK excludes every bound;
 * - a partitioned index has no storage, so its SET TABLESPACE rewrites nothing;
 * - an array of a domain takes no default from the domain.
 */
import { describe, expect, it } from "vitest"
import { classifyMigration } from "./classify.ts"
import { extractSchema } from "./schema.ts"

const HISTORY = `CREATE TABLE u (id int PRIMARY KEY);
CREATE TABLE t (id int PRIMARY KEY);
CREATE TABLE pt (id int, u_id int) PARTITION BY RANGE (id);
CREATE TABLE pt1 PARTITION OF pt FOR VALUES FROM (0) TO (100);
CREATE TABLE ev (id int, at date) PARTITION BY RANGE (at);
CREATE TABLE ev_a PARTITION OF ev FOR VALUES FROM ('2020-01-01') TO ('2021-01-01');
CREATE INDEX ev_at ON ev (at);
CREATE INDEX ev_a_id ON ev_a (id);
CREATE TABLE d (id int, at date);
`

/** `later`'s rating after HISTORY and `more`, all read as Postgres */
const rate = (later: string, more = "") =>
	classifyMigration(later, { before: extractSchema(`${HISTORY}${more}`, undefined, "postgres"), dialect: "postgres" })

const REWRITES = "rewrites or scans the table under an exclusive lock"

describe("an added column's inline foreign key (P18 of r19)", () => {
	it("warns of nothing while the column is NULL, which Postgres checks against nothing", () => {
		expect(rate("ALTER TABLE t ADD COLUMN w int REFERENCES u (id);").lockWarnings).toEqual([])
	})

	it("warns of the scan of both tables once a default fills the column, with the NOT VALID recipe", () => {
		expect(rate("ALTER TABLE t ADD COLUMN w int DEFAULT 1 REFERENCES u (id);").lockWarnings).toEqual([
			"ALTER TABLE t ADD COLUMN w int DEFAULT 1 REFERENCES u (id) (scans t, blocking writes to t and u; add the column, then the foreign key NOT VALID, then VALIDATE CONSTRAINT in a later file)",
		])
	})
})

describe("a foreign key on a partitioned table (P18 of r19)", () => {
	const NOT_VALID = "ALTER TABLE pt ADD CONSTRAINT fk FOREIGN KEY (u_id) REFERENCES u (id) NOT VALID;"

	it("refuses one NOT VALID, which Postgres refuses on every database, naming the recipe", () => {
		expect(() => rate(NOT_VALID)).toThrow(
			`${NOT_VALID.slice(0, -1)}: Postgres refuses a NOT VALID foreign key on the partitioned table pt: add it NOT VALID to each partition, VALIDATE CONSTRAINT on each in a later file, then add it to pt, which then scans nothing`,
		)
	})

	it("refuses one on a partitioned table renamed or moved, and passes one on a plain table made in its name", () => {
		expect(() => rate(NOT_VALID.replace("pt", "qt"), "ALTER TABLE pt RENAME TO qt;")).toThrow("partitioned table qt")
		expect(() => rate(NOT_VALID.replace("pt", "s.pt"), "CREATE SCHEMA s;\nALTER TABLE pt SET SCHEMA s;")).toThrow(
			"partitioned table s.pt",
		)
		const plain = "DROP TABLE pt;\nCREATE TABLE pt (id int, u_id int);"
		expect(rate(NOT_VALID, plain).lockWarnings).toEqual([])
	})

	it("warns that a valid one scans every partition, with the recipe that scans none of them at once", () => {
		expect(rate("ALTER TABLE pt ADD CONSTRAINT fk FOREIGN KEY (u_id) REFERENCES u (id);").lockWarnings).toEqual([
			"ALTER TABLE pt ADD CONSTRAINT fk FOREIGN KEY (u_id) REFERENCES u (id) (scans every partition of pt, blocking writes to them and u; add it NOT VALID to each partition, VALIDATE CONSTRAINT on each in a later file, then add it to pt, which then scans nothing)",
		])
	})

	it("keeps a plain table's note", () => {
		expect(rate("ALTER TABLE t ADD CONSTRAINT fk FOREIGN KEY (id) REFERENCES u (id);").lockWarnings).toEqual([
			"ALTER TABLE t ADD CONSTRAINT fk FOREIGN KEY (id) REFERENCES u (id) (scans t, blocking writes to t and u; add it NOT VALID, then VALIDATE CONSTRAINT in a later file)",
		])
	})
})

describe("ATTACH PARTITION … DEFAULT (P20 of r19)", () => {
	it("says what Postgres checks a default partition for, with the CHECK that excludes every bound", () => {
		expect(rate("ALTER TABLE ev ATTACH PARTITION d DEFAULT;").lockWarnings).toEqual([
			"ALTER TABLE ev ATTACH PARTITION d DEFAULT (scans d under an exclusive lock for rows another partition's bound takes; add a CHECK constraint to d that excludes every other partition's bound NOT VALID, VALIDATE it in a later file, then ATTACH)",
		])
	})
})

describe("a partitioned index's SET TABLESPACE (P19 of r19)", () => {
	it("warns of nothing, as a partitioned index has no storage to move, renamed or not", () => {
		expect(rate("ALTER INDEX ev_at SET TABLESPACE pg_default;").lockWarnings).toEqual([])
		expect(
			rate("ALTER INDEX ev_when SET TABLESPACE pg_default;", "ALTER INDEX ev_at RENAME TO ev_when;").lockWarnings,
		).toEqual([])
	})

	it("warns of a partition's own index, and of one made again on a plain table in its name", () => {
		expect(rate("ALTER INDEX ev_a_id SET TABLESPACE pg_default;").lockWarnings).toEqual([
			`ALTER INDEX ev_a_id SET TABLESPACE pg_default (${REWRITES})`,
		])
		const again = "DROP INDEX ev_at;\nCREATE INDEX ev_at ON t (id);"
		expect(rate("ALTER INDEX ev_at SET TABLESPACE pg_default;", again).lockWarnings).toEqual([
			`ALTER INDEX ev_at SET TABLESPACE pg_default (${REWRITES})`,
		])
	})
})

describe("an added column of an array of a domain (P19 of r19)", () => {
	it("takes no default from the domain, and warns of nothing", () => {
		expect(
			rate("ALTER TABLE t ADD COLUMN x dv[];", "CREATE DOMAIN dv AS float8 DEFAULT random();\n").lockWarnings,
		).toEqual([])
	})
})

/* P9 of r21: a CLUSTER or REINDEX of a partitioned table or index runs only outside a transaction block */
/** check's refusal of `what` in a file's transaction */
const OUTSIDE = (what: string) =>
	`Postgres runs ${what} only outside a transaction; put it in a file of its own that starts with "-- atlas:txmode none" and a blank line`

describe("a CLUSTER or REINDEX of a partitioned table or index (P9 of r21)", () => {
	it.each([
		["CLUSTER ev USING ev_at;", "CLUSTER"],
		["REINDEX TABLE ev;", "REINDEX TABLE"],
		["REINDEX INDEX ev_at;", "REINDEX INDEX"],
	])("refuses %j in a file's transaction, as Postgres refuses it", (sql, what) => {
		expect(() => rate(sql)).toThrow(OUTSIDE(what))
		expect(() => rate(`-- atlas:txmode none\n\n${sql}`)).not.toThrow()
	})

	it("refuses one of a table the file itself partitions, and passes a plain table's and a partition's", () => {
		expect(() => rate("CREATE TABLE q (a int) PARTITION BY LIST (a);\nREINDEX TABLE q;")).toThrow(
			OUTSIDE("REINDEX TABLE"),
		)
		expect(() => rate("CLUSTER t USING t_pkey;\nREINDEX TABLE ev_a;\nREINDEX INDEX ev_a_id;")).not.toThrow()
	})
})
