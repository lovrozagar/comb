/**
 * The locks a statement takes through a foreign key, held to its file's COMMIT and read through the
 * VALIDATE that scans under them (the gaps 1–4 of 0005's review, the class of PA8 of r22b): a dropped
 * key, a dropped table's keys and the keys to it, a TRUNCATE CASCADE's referencing tables, a key column
 * retyped, and a partition made, attached or detached under a parent's keys each lock the table at the
 * key's other end. Each case runs a statement, then the VALIDATE, as Atlas runs a file, in one
 * transaction, reads what the transaction holds from pg_locks, and holds comb's warning to it.
 */
import { beforeAll, describe, expect, it } from "vitest"
import { classifyMigration } from "../../../src/migrate/core/classify.ts"
import { loadPostgresParser } from "../../../src/migrate/core/pg-parser.ts"
import { extractSchema } from "../../../src/migrate/core/schema.ts"
import { withScratchDb } from "../support/pg.ts"
import { heldBy, type Unnamed, warningOf } from "../support/pg-locks.ts"

beforeAll(loadPostgresParser)

const HISTORY = [
	"CREATE TABLE users (id int PRIMARY KEY, n int);",
	"CREATE TABLE orders (id int PRIMARY KEY, user_id int CONSTRAINT o_fk REFERENCES users (id));",
	"CREATE TABLE items (id int, order_id int REFERENCES orders);",
	"CREATE TABLE ev (id int NOT NULL, at date NOT NULL, user_id int REFERENCES users (id)) PARTITION BY RANGE (at);",
	"CREATE TABLE ev_old PARTITION OF ev FOR VALUES FROM ('2020-01-01') TO ('2021-01-01');",
	"CREATE TABLE ev_loose (id int NOT NULL, at date NOT NULL, user_id int);",
	"CREATE TABLE users_copy (LIKE users INCLUDING ALL);",
	"CREATE TABLE uc (u int REFERENCES users_copy);",
	"CREATE TABLE audit (n int);",
	"ALTER TABLE audit ADD CONSTRAINT pos CHECK (n > 0) NOT VALID;",
].join("\n")

const VALIDATE = "ALTER TABLE audit VALIDATE CONSTRAINT pos;"
const [READS, WRITES] = ["reads and writes", "writes"]

/** comb's warnings of the VALIDATE after `first`, in its file */
const validateWarnings = (first: string): string[] =>
	classifyMigration(`${first}\n${VALIDATE}\n`, {
		before: extractSchema(HISTORY, undefined, "postgres"),
		dialect: "postgres",
	}).lockWarnings.filter((warning) => warning.startsWith(`${VALIDATE.slice(0, -1)} (`))

// lookup-table: each statement before the VALIDATE, with what Postgres 17 holds blocked at the file's end
const CASES: ReadonlyArray<readonly [string, Readonly<Record<string, string>>]> = [
	/* a key dropped, by its name, its generated name, through a parent's partitions, and through its rename */
	["ALTER TABLE orders DROP CONSTRAINT o_fk;", { orders: READS, users: READS }],
	["ALTER TABLE items DROP CONSTRAINT items_order_id_fkey;", { items: READS, orders: READS }],
	["ALTER TABLE ev DROP CONSTRAINT ev_user_id_fkey;", { ev: READS, ev_old: READS, users: READS }],
	[
		"ALTER TABLE orders RENAME CONSTRAINT o_fk TO o_fk2;\nALTER TABLE orders DROP CONSTRAINT o_fk2;",
		{ orders: READS, users: READS },
	],
	/* a table dropped: what its keys reference, what references it under CASCADE, a partition's parent */
	["DROP TABLE items;", { items: READS, orders: READS }],
	["DROP TABLE ev;", { ev: READS, ev_old: READS, users: READS }],
	["DROP TABLE ev_old;", { ev: READS, ev_old: READS }],
	["DROP TABLE orders CASCADE;", { items: READS, orders: READS, users: READS }],
	["DROP TABLE users CASCADE;", { ev: READS, ev_old: READS, orders: READS, users: READS }],
	/* a TRUNCATE CASCADE, through each table that references what it truncates */
	["TRUNCATE users CASCADE;", { ev: READS, ev_old: READS, items: READS, orders: READS, users: READS }],
	["TRUNCATE ONLY orders CASCADE;", { items: READS, orders: READS }],
	["TRUNCATE items;", { items: READS }],
	/* a key's column dropped or retyped, at either end, a primary key a REFERENCES without columns names */
	["ALTER TABLE orders DROP COLUMN user_id;", { orders: READS, users: READS }],
	["ALTER TABLE orders ALTER COLUMN user_id TYPE bigint;", { orders: READS, users: READS }],
	["ALTER TABLE users ALTER COLUMN id TYPE bigint;", { ev: READS, ev_old: READS, orders: READS, users: READS }],
	["ALTER TABLE orders ALTER COLUMN id TYPE bigint;", { items: READS, orders: READS }],
	["ALTER TABLE users DROP COLUMN id CASCADE;", { ev: READS, ev_old: READS, orders: READS, users: READS }],
	["ALTER TABLE users DROP CONSTRAINT users_pkey CASCADE;", { ev: READS, ev_old: READS, orders: READS, users: READS }],
	["ALTER TABLE users ALTER COLUMN n TYPE bigint;", { users: READS }],
	/* a primary key a LIKE copied with the indexes, under the name a new one takes */
	["ALTER TABLE users_copy DROP CONSTRAINT users_copy_pkey CASCADE;", { uc: READS, users_copy: READS }],
	/* a partition made, attached or detached under a parent's keys */
	[
		"CREATE TABLE ev_new PARTITION OF ev FOR VALUES FROM ('2021-01-01') TO ('2022-01-01');",
		{ ev: READS, users: WRITES },
	],
	[
		"ALTER TABLE ev ATTACH PARTITION ev_loose FOR VALUES FROM ('2022-01-01') TO ('2023-01-01');",
		{ ev_loose: READS, users: WRITES },
	],
	["ALTER TABLE ev DETACH PARTITION ev_old;", { ev: READS, ev_old: READS, users: WRITES }],
]

// lookup-table: the CASES whose map says it locks what it cannot name: the objects a DROP … CASCADE dropped, and a dropped table's sequences
const UNNAMED: Readonly<Record<string, Unnamed>> = {
	"ALTER TABLE users DROP COLUMN id CASCADE;": { cascades: ["users.id"] },
	"ALTER TABLE users DROP CONSTRAINT users_pkey CASCADE;": { cascades: ["users_pkey on users"] },
	"ALTER TABLE users_copy DROP CONSTRAINT users_copy_pkey CASCADE;": { cascades: ["users_copy_pkey on users_copy"] },
	"DROP TABLE ev;": { others: ["the sequences ev owns"] },
	"DROP TABLE ev_old;": { others: ["the sequences ev_old owns"] },
	"DROP TABLE items;": { others: ["the sequences items owns"] },
	"DROP TABLE orders CASCADE;": { cascades: ["orders"], others: ["the sequences orders owns"] },
	"DROP TABLE users CASCADE;": { cascades: ["users"], others: ["the sequences users owns"] },
}

describe("a VALIDATE after a statement that locks through a foreign key on Postgres 17 (gaps 1–4 of 0005)", () => {
	it.each(CASES)(
		"after %s, warns exactly when Postgres holds a blocking lock, naming what it holds",
		async (first, held) => {
			await withScratchDb(async (url) => {
				expect(await heldBy(url, [HISTORY], `${first}\n${VALIDATE}\n`)).toEqual(held)
			})
			expect(validateWarnings(first)).toEqual(warningOf({ table: "audit", validate: VALIDATE }, held, UNNAMED[first]))
		},
		60_000,
	)
})
