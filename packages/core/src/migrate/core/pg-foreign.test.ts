/**
 * The foreign keys a Postgres history leaves, followed through what renames, moves and drops them,
 * read through the locks a statement takes at a key's other end (the gaps 1–4 of 0005 of r22b).
 * tests/integration/postgres/lock-oracle-held-fk.test.ts holds each kind of reach to Postgres 17's
 * pg_locks; these hold the names Postgres gives a key, Postgres's own measured in the case comments,
 * and the history's keys through each statement that changes them.
 */
import { beforeAll, describe, expect, it } from "vitest"
import { classifyMigration } from "./classify.ts"
import { loadPostgresParser } from "./pg-parser.ts"
import { extractSchema } from "./schema.ts"

beforeAll(loadPostgresParser)

const [LONG_TABLE, LONG_COLUMN] = ["l".repeat(40), "c".repeat(40)]
const [WIDE_TABLE, WIDE_COLUMN] = ["ž".repeat(30), "č".repeat(20)]

const HISTORY = [
	"CREATE TABLE users (id int PRIMARY KEY, n int);",
	"CREATE TABLE orders (id int PRIMARY KEY, user_id int CONSTRAINT o_fk REFERENCES users (id));",
	"CREATE TABLE items (id int, order_id int REFERENCES orders);",
	"CREATE TABLE ev (id int NOT NULL, at date NOT NULL, user_id int REFERENCES users (id)) PARTITION BY RANGE (at);",
	"CREATE TABLE ev_old PARTITION OF ev FOR VALUES FROM ('2020-01-01') TO ('2021-01-01');",
	"CREATE TABLE ev_mid PARTITION OF ev FOR VALUES FROM ('2021-01-01') TO ('2022-01-01') PARTITION BY LIST (id);",
	"CREATE TABLE t2 (u int REFERENCES users (id), FOREIGN KEY (u) REFERENCES orders (id));",
	`CREATE TABLE ${LONG_TABLE} (${LONG_COLUMN} int REFERENCES users);`,
	`CREATE TABLE ${WIDE_TABLE} (${WIDE_COLUMN} int REFERENCES users);`,
	"CREATE TABLE k (id int);",
	"ALTER TABLE k ADD PRIMARY KEY (id);",
	"CREATE TABLE kr (k_id int);",
	"ALTER TABLE kr ADD COLUMN k2 int REFERENCES k, ADD CONSTRAINT kr_fk FOREIGN KEY (k_id) REFERENCES k NOT VALID;",
	"CREATE TABLE kq (id int);",
	"CREATE UNIQUE INDEX kq_k ON kq (id);",
	"ALTER TABLE kq ADD PRIMARY KEY USING INDEX kq_k;",
	"CREATE TABLE kp (q int REFERENCES kq);",
	"CREATE TABLE kc (LIKE k INCLUDING ALL);",
	"CREATE TABLE kcr (c int REFERENCES kc);",
	"CREATE TABLE kn (CONSTRAINT kn_own PRIMARY KEY (id), LIKE k INCLUDING ALL EXCLUDING INDEXES);",
	"CREATE TABLE knr (n int REFERENCES kn);",
	"CREATE TABLE kl (CONSTRAINT kl_own PRIMARY KEY (id), LIKE k);",
	"CREATE TABLE klr (l int REFERENCES kl);",
	"CREATE SCHEMA s;",
	"CREATE TABLE s.a (id int PRIMARY KEY);",
	"CREATE TABLE s.b (a_id int REFERENCES s.a);",
	"CREATE TABLE audit (n int);",
	"ALTER TABLE audit ADD CONSTRAINT pos CHECK (n > 0) NOT VALID;",
].join("\n")

const VALIDATE = "ALTER TABLE audit VALIDATE CONSTRAINT pos;"

/** What comb says the file holds when `first` runs before VALIDATE in it; "" when it warns of none */
function holds(first: string): string {
	const rated = classifyMigration(`${first}\n${VALIDATE}\n`, {
		before: extractSchema(HISTORY, undefined, "postgres"),
		dialect: "postgres",
	})
	const warning = rated.lockWarnings.find((each) => each.startsWith(`${VALIDATE.slice(0, -1)} (`))
	return warning?.match(/while this file holds (.*); those locks last to the file's COMMIT/)?.[1] ?? ""
}

/* each statement before the VALIDATE, and what comb says the file then holds */
const HOLDS: Array<[string, string]> = [
	/* the names Postgres chose: the longer of table and columns cut first to 63 bytes, a character never split, a taken name numbered */
	[
		`ALTER TABLE ${LONG_TABLE} DROP CONSTRAINT ${"l".repeat(29)}_${"c".repeat(28)}_fkey;`,
		`${LONG_TABLE} and users locked against reads and writes`,
	],
	[
		`ALTER TABLE ${WIDE_TABLE} DROP CONSTRAINT ${"ž".repeat(14)}_${"č".repeat(14)}_fkey;`,
		`users and ${WIDE_TABLE} locked against reads and writes`,
	],
	["ALTER TABLE t2 DROP CONSTRAINT t2_u_fkey1;", "orders and t2 locked against reads and writes"],
	/* keys an ALTER TABLE added, a primary key a REFERENCES without columns names among them */
	["ALTER TABLE k ALTER COLUMN id TYPE bigint;", "k and kr locked against reads and writes"],
	["ALTER TABLE kr DROP CONSTRAINT kr_k2_fkey;", "k and kr locked against reads and writes"],
	["ALTER TABLE kr DROP CONSTRAINT kr_fk;", "k and kr locked against reads and writes"],
	/* a primary key an index makes, named by it unless the constraint is */
	["ALTER TABLE kq DROP CONSTRAINT kq_k CASCADE;", "kp and kq locked against reads and writes"],
	/* a primary key a LIKE copies with the indexes, named as a new one is, and none without them */
	["ALTER TABLE kc DROP CONSTRAINT kc_pkey CASCADE;", "kc and kcr locked against reads and writes"],
	["ALTER TABLE kn DROP CONSTRAINT kn_own CASCADE;", "kn and knr locked against reads and writes"],
	["ALTER TABLE kl DROP CONSTRAINT kl_own CASCADE;", "kl and klr locked against reads and writes"],
	/* through a rename of the table, its column, its constraint, a column it references */
	[
		"ALTER TABLE users RENAME TO people;\nTRUNCATE people CASCADE;",
		`ev, ev_mid, ev_old, items, ${LONG_TABLE}, orders, people, t2, users and ${WIDE_TABLE} locked against reads and writes`,
	],
	[
		"ALTER TABLE orders RENAME COLUMN user_id TO uid;\nALTER TABLE orders DROP COLUMN uid;",
		"orders and users locked against reads and writes",
	],
	[
		"ALTER TABLE users RENAME COLUMN id TO uid;\nALTER TABLE users ALTER COLUMN uid TYPE bigint;",
		`ev, ev_mid, ev_old, ${LONG_TABLE}, orders, t2, users and ${WIDE_TABLE} locked against reads and writes`,
	],
	[
		"ALTER TABLE orders RENAME CONSTRAINT orders_pkey TO opk;\nALTER TABLE orders DROP CONSTRAINT opk CASCADE;",
		"items, orders and t2 locked against reads and writes",
	],
	/* through a table's move to another schema, whose own lock the map leaves to the replay, and a schema's rename */
	[
		"ALTER TABLE orders SET SCHEMA s;\nALTER TABLE s.orders DROP CONSTRAINT o_fk;",
		"s.orders and users locked against reads and writes",
	],
	["ALTER SCHEMA s RENAME TO s2;\nDROP TABLE s2.b;", "s2.a and s2.b locked against reads and writes"],
	/* a key the file adds, and one a CREATE IF NOT EXISTS of a table the history holds leaves */
	[
		"ALTER TABLE audit ADD COLUMN u int REFERENCES users (id);\nALTER TABLE audit DROP COLUMN u;",
		"audit and users locked against reads and writes",
	],
	[
		"CREATE TABLE IF NOT EXISTS orders (id int);\nALTER TABLE orders DROP CONSTRAINT o_fk;",
		"orders and users locked against reads and writes",
	],
	/* keys the file dropped, which a later change no longer reaches */
	[
		"ALTER TABLE orders DROP CONSTRAINT o_fk;\nALTER TABLE users ALTER COLUMN n TYPE bigint;",
		"orders and users locked against reads and writes",
	],
	["DROP TABLE t2;\nTRUNCATE orders CASCADE;", "items, orders, t2 and users locked against reads and writes"],
	[
		"ALTER TABLE orders DROP CONSTRAINT orders_pkey CASCADE;\nALTER TABLE orders ADD PRIMARY KEY (user_id);\nALTER TABLE orders ALTER COLUMN id TYPE bigint;",
		"items, orders and t2 locked against reads and writes",
	],
	/* what a change that drops no key reaches: none */
	["ALTER TABLE users DROP COLUMN n CASCADE;", "users locked against reads and writes"],
	["ALTER TABLE users DROP CONSTRAINT nope CASCADE;", "users locked against reads and writes"],
	["ALTER TABLE users DROP COLUMN id;", "users locked against reads and writes"],
	/* a partition under a parent's parent's keys */
	[
		"CREATE TABLE ev_mid1 PARTITION OF ev_mid FOR VALUES IN (1);",
		"ev_mid locked against reads and writes, and users against writes",
	],
]

describe("the foreign keys a history leaves, and what a statement reaches through them (gaps 1–4 of 0005)", () => {
	it.each(HOLDS)("%s holds %s", (first, held) => {
		expect(holds(first)).toBe(held)
	})

	it("reaches no key without columns to a table whose primary key the history does not hold", () => {
		const rated = classifyMigration(`ALTER TABLE made ALTER COLUMN id TYPE bigint;\n${VALIDATE}\n`, {
			before: extractSchema(
				"CREATE TABLE refs (m int REFERENCES made);\nCREATE TABLE audit (n int);\nALTER TABLE audit ADD CONSTRAINT pos CHECK (n > 0) NOT VALID;",
				undefined,
				"postgres",
			),
			dialect: "postgres",
		})
		expect(rated.lockWarnings.find((each) => each.startsWith(`${VALIDATE.slice(0, -1)} (`))).toContain(
			"while this file holds made locked against reads and writes;",
		)
	})

	it("reaches nothing through a temporary table, which no other session sees", () => {
		expect(holds("CREATE TEMP TABLE tt (id int);\nALTER TABLE pg_temp.tt DROP COLUMN id;")).toBe("")
	})
})
