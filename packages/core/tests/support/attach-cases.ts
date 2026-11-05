/**
 * The ATTACH cases of PA16 of r22b, each a history and an ATTACH after it: IMPLIED those whose bound
 * the history's validated CHECKs imply, so Postgres 17 skips the partition's scan and comb warns of
 * nothing; SCANNED those comb cannot prove, which keep the scan's warning.
 * src/migrate/core/pg-bounds.test.ts rates each, and
 * tests/integration/postgres/attach-implied-oracle.test.ts runs each on Postgres.
 */

/** A case: what it is, the history before, the ATTACH */
export type AttachCase = readonly [what: string, history: string, attach: string]

export const PARENT = `CREATE TABLE ev (id int, at date NOT NULL) PARTITION BY RANGE (at);
CREATE TABLE ev_2025 PARTITION OF ev FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');
`
export const BOUND = "CHECK (at >= '2026-01-01' AND at < '2027-01-01')"
export const PARTITION = `CREATE TABLE o (id int, at date NOT NULL);
ALTER TABLE o ADD CONSTRAINT o_b ${BOUND} NOT VALID;
ALTER TABLE o VALIDATE CONSTRAINT o_b;
`
export const ATTACH = "ALTER TABLE ev ATTACH PARTITION o FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');"
export const SCANS = "scans o under an exclusive lock to check its bound"

const plain = `${PARENT}CREATE TABLE o (id int, at date NOT NULL);\n`

/** `n` distinct text constants, past the 100 a list proof of Postgres's (MAX_SAOP_ARRAY_SIZE) reads */
const values = (n: number): string[] => Array.from({ length: n }, (_, i) => `'v${i}'`)

export const IMPLIED: readonly AttachCase[] = [
	["the recipe: a CHECK added NOT VALID, then validated", `${PARENT}${PARTITION}`, ATTACH],
	[
		"a CHECK validated as it is added",
		`${PARENT}CREATE TABLE o (id int, at date NOT NULL);\nALTER TABLE o ADD ${BOUND};\n`,
		ATTACH,
	],
	["a CHECK the CREATE TABLE writes", `${PARENT}CREATE TABLE o (id int, at date NOT NULL, ${BOUND});\n`, ATTACH],
	[
		"a column's own CHECK, its sides swapped",
		`${PARENT}CREATE TABLE o (id int, at date NOT NULL CHECK ('2026-01-01' <= at AND '2027-01-01' > at));\n`,
		ATTACH,
	],
	[
		"the key NOT NULL by a CHECK's IS NOT NULL, under a parent whose key is nullable",
		`${PARENT.replace("at date NOT NULL", "at date")}CREATE TABLE o (id int, at date, CHECK (at IS NOT NULL), ${BOUND});\n`,
		ATTACH,
	],
	[
		"the key NOT NULL by a later SET NOT NULL",
		`${PARENT}CREATE TABLE o (id int, at date, ${BOUND});\nALTER TABLE o ALTER COLUMN at SET NOT NULL;\n`,
		ATTACH,
	],
	[
		"a bound from MINVALUE",
		`${PARENT}CREATE TABLE o (id int, at date NOT NULL, CHECK (at < '2025-01-01'));\n`,
		"ALTER TABLE ev ATTACH PARTITION o FOR VALUES FROM (MINVALUE) TO ('2025-01-01');",
	],
	[
		"a bound to MAXVALUE",
		`${PARENT}CREATE TABLE o (id int, at date NOT NULL, CHECK (at >= '2026-01-01'));\n`,
		"ALTER TABLE ev ATTACH PARTITION o FOR VALUES FROM ('2026-01-01') TO (MAXVALUE);",
	],
	[
		"an integer key from 0",
		"CREATE TABLE n (k int NOT NULL) PARTITION BY RANGE (k);\nCREATE TABLE o (k int NOT NULL CHECK (k >= 0 AND k < 100));\n",
		"ALTER TABLE n ATTACH PARTITION o FOR VALUES FROM (0) TO (100);",
	],
	[
		"a bigint key past int4",
		"CREATE TABLE n (k bigint NOT NULL) PARTITION BY RANGE (k);\nCREATE TABLE o (k bigint NOT NULL CHECK (k >= -1 AND k < 3000000000));\n",
		"ALTER TABLE n ATTACH PARTITION o FOR VALUES FROM (-1) TO (3000000000);",
	],
	[
		"a timestamp key",
		"CREATE TABLE n (t timestamp NOT NULL) PARTITION BY RANGE (t);\nCREATE TABLE o (t timestamp NOT NULL CHECK (t >= '2026-01-01 00:00:00' AND t < '2027-01-01'));\n",
		"ALTER TABLE n ATTACH PARTITION o FOR VALUES FROM ('2026-01-01 00:00:00') TO ('2027-01-01');",
	],
	[
		"a list key, the CHECK's IN list within the bound's",
		"CREATE TABLE l (c text NOT NULL) PARTITION BY LIST (c);\nCREATE TABLE o (c text NOT NULL CHECK (c IN ('a', 'b')));\n",
		"ALTER TABLE l ATTACH PARTITION o FOR VALUES IN ('a', 'b', 'c');",
	],
	[
		"a varchar list key, one value",
		"CREATE TABLE l (c varchar(9) NOT NULL) PARTITION BY LIST (c);\nCREATE TABLE o (c varchar(9) NOT NULL CHECK (c = 'a'));\n",
		"ALTER TABLE l ATTACH PARTITION o FOR VALUES IN ('a');",
	],
	[
		"the partition renamed",
		`${PARENT}${PARTITION}ALTER TABLE o RENAME TO o2;\n`,
		"ALTER TABLE ev ATTACH PARTITION o2 FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');",
	],
	[
		"the parent renamed",
		`${PARENT}${PARTITION}ALTER TABLE ev RENAME TO ev2;\n`,
		"ALTER TABLE ev2 ATTACH PARTITION o FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');",
	],
	[
		"the partition moved to another schema",
		`${PARENT}${PARTITION}CREATE SCHEMA s;\nALTER TABLE o SET SCHEMA s;\n`,
		"ALTER TABLE ev ATTACH PARTITION s.o FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');",
	],
	[
		"the CHECK renamed before its VALIDATE",
		`${PARENT}CREATE TABLE o (id int, at date NOT NULL);\nALTER TABLE o ADD CONSTRAINT o_b ${BOUND} NOT VALID;\nALTER TABLE o RENAME CONSTRAINT o_b TO o_c;\nALTER TABLE o VALIDATE CONSTRAINT o_c;\n`,
		ATTACH,
	],
	[
		"the key NOT NULL as the column's PRIMARY KEY",
		`${PARENT}CREATE TABLE o (id int, at date PRIMARY KEY, ${BOUND});\n`,
		ATTACH,
	],
	[
		"another CHECK validated, and a table PRIMARY KEY",
		`${PARENT}${PARTITION}ALTER TABLE o ADD CONSTRAINT p CHECK (id > 0) NOT VALID;\nALTER TABLE o VALIDATE CONSTRAINT p;\nALTER TABLE o ADD PRIMARY KEY (id, at);\n`,
		ATTACH,
	],
	[
		"another constraint renamed, on the partition and on a table whose proof a dropped column forgot",
		`${PARENT}${PARTITION}ALTER TABLE o ADD CONSTRAINT u UNIQUE (id);\nALTER TABLE o RENAME CONSTRAINT u TO u2;\nCREATE TABLE elsewhere (id int, n int, CONSTRAINT a UNIQUE (id));\nALTER TABLE elsewhere DROP COLUMN n;\nALTER TABLE elsewhere RENAME CONSTRAINT a TO b;\n`,
		ATTACH,
	],
	[
		"a column added to the parent and the partition and a CREATE TABLE IF NOT EXISTS of it since",
		`${PARENT}${PARTITION}ALTER TABLE ev ADD COLUMN note text NOT NULL DEFAULT '';\nALTER TABLE o ADD COLUMN note text NOT NULL DEFAULT '';\nCREATE TABLE IF NOT EXISTS o (id int);\n`,
		ATTACH,
	],
]

export const SCANNED: readonly AttachCase[] = [
	["a CHECK left NOT VALID", `${plain}ALTER TABLE o ADD CONSTRAINT o_b ${BOUND} NOT VALID;\n`, ATTACH],
	["a CHECK NO INHERIT", `${plain}ALTER TABLE o ADD CONSTRAINT o_b ${BOUND} NO INHERIT;\n`, ATTACH],
	["no CHECK", plain, ATTACH],
	["a key that may be null", `${PARENT}CREATE TABLE o (id int, at date, ${BOUND});\n`, ATTACH],
	[
		"a CHECK with a term comb does not read",
		`${plain}ALTER TABLE o ADD CHECK (at >= '2026-01-01' AND at < '2027-01-01' AND id > length('x'));\n`,
		ATTACH,
	],
	[
		"a CHECK of an OR",
		`${plain}ALTER TABLE o ADD CHECK (at >= '2026-01-01' AND (at < '2027-01-01' OR id = 1));\n`,
		ATTACH,
	],
	[
		"a CHECK tighter than the bound",
		`${plain}ALTER TABLE o ADD CHECK (at >= '2026-02-01' AND at < '2027-01-01');\n`,
		ATTACH,
	],
	[
		"a CHECK with <= for the upper bound",
		`${plain}ALTER TABLE o ADD CHECK (at >= '2026-01-01' AND at <= '2027-01-01');\n`,
		ATTACH,
	],
	["a CHECK of another column", `${plain}ALTER TABLE o ADD CHECK (id >= 1 AND id < 2);\n`, ATTACH],
	[
		"a CHECK whose constant is cast",
		`${plain}ALTER TABLE o ADD CHECK (at >= '2026-01-01'::date AND at < '2027-01-01');\n`,
		ATTACH,
	],
	[
		"a >= a migration defined",
		`CREATE OPERATOR >= (FUNCTION = date_ge, LEFTARG = date, RIGHTARG = date);\n${plain}ALTER TABLE o ADD ${BOUND};\n`,
		ATTACH,
	],
	[
		"the CHECK validated in the ALTER that drops another",
		`${plain}ALTER TABLE o ADD CONSTRAINT o_b ${BOUND} NOT VALID;\nALTER TABLE o ADD CONSTRAINT u UNIQUE (id);\nALTER TABLE o DROP CONSTRAINT u, VALIDATE CONSTRAINT o_b;\n`,
		ATTACH,
	],
	["a key a CHECK holds IS NULL", `${PARENT}CREATE TABLE o (id int, at date, CHECK (at IS NULL), ${BOUND});\n`, ATTACH],
	[
		"a CHECK with <>",
		`${plain}ALTER TABLE o ADD CHECK (at >= '2026-01-01' AND at < '2027-01-01' AND at <> '2026-06-01');\n`,
		ATTACH,
	],
	[
		"a CHECK of a schema-qualified operator",
		`${plain}ALTER TABLE o ADD CHECK (at OPERATOR(pg_catalog.>=) '2026-01-01' AND at < '2027-01-01');\n`,
		ATTACH,
	],
	[
		"an integer key bounded by a fraction",
		"CREATE TABLE n (k int NOT NULL) PARTITION BY RANGE (k);\nCREATE TABLE o (k int NOT NULL CHECK (k >= 0.5 AND k < 9));\n",
		"ALTER TABLE n ATTACH PARTITION o FOR VALUES FROM (0.5) TO (9);",
	],
	[
		"a key bounded by a boolean, which Postgres refuses",
		"CREATE TABLE n (k int NOT NULL) PARTITION BY RANGE (k);\nCREATE TABLE o (k int NOT NULL CHECK (k >= 0 AND k < 9));\n",
		"ALTER TABLE n ATTACH PARTITION o FOR VALUES FROM (true) TO (9);",
	],
	[
		"a list CHECK holding a call",
		"CREATE TABLE l (c text NOT NULL) PARTITION BY LIST (c);\nCREATE TABLE o (c text NOT NULL CHECK (c IN ('a', upper('b'))));\n",
		"ALTER TABLE l ATTACH PARTITION o FOR VALUES IN ('a', 'B');",
	],
	[
		"a list bound on a range key, which Postgres refuses",
		`${PARENT}CREATE TABLE o (id int, at date NOT NULL, CHECK (at IN ('2026-01-01')));\n`,
		"ALTER TABLE ev ATTACH PARTITION o FOR VALUES IN ('2026-01-01');",
	],
	[
		"a range bound on a list key, which Postgres refuses",
		"CREATE TABLE l (c int NOT NULL) PARTITION BY LIST (c);\nCREATE TABLE o (c int NOT NULL CHECK (c >= 0 AND c < 9));\n",
		"ALTER TABLE l ATTACH PARTITION o FOR VALUES FROM (0) TO (9);",
	],
	[
		"a range bound of two values on a one-column key, which Postgres refuses",
		`${PARENT}${PARTITION}`,
		"ALTER TABLE ev ATTACH PARTITION o FOR VALUES FROM ('2026-01-01', 0) TO ('2027-01-01', 0);",
	],
	["the CHECK dropped", `${PARENT}${PARTITION}ALTER TABLE o DROP CONSTRAINT o_b;\n`, ATTACH],
	[
		"another constraint dropped",
		`${PARENT}${PARTITION}ALTER TABLE o ADD CONSTRAINT u UNIQUE (id);\nALTER TABLE o DROP CONSTRAINT u;\n`,
		ATTACH,
	],
	["the key's NOT NULL dropped", `${PARENT}${PARTITION}ALTER TABLE o ALTER COLUMN at DROP NOT NULL;\n`, ATTACH],
	["the key retyped", `${PARENT}${PARTITION}ALTER TABLE o ALTER COLUMN at TYPE timestamp;\n`, ATTACH],
	[
		"the key dropped and added again",
		`${PARENT}${PARTITION}ALTER TABLE o DROP COLUMN at;\nALTER TABLE o ADD COLUMN at date NOT NULL;\n`,
		ATTACH,
	],
	[
		"a column renamed",
		`${PARENT}CREATE TABLE o (id int, x date NOT NULL, CHECK (x >= '2026-01-01' AND x < '2027-01-01'));\nALTER TABLE o RENAME COLUMN x TO at;\n`,
		ATTACH,
	],
	[
		"a column of the parent dropped, which reaches its children",
		`CREATE TABLE base (at date NOT NULL);\n${PARENT}${PARTITION.replace("(id int, at date NOT NULL);", "(id int) INHERITS (base);")}ALTER TABLE base DROP COLUMN at;\nALTER TABLE o ADD COLUMN at date NOT NULL;\nALTER TABLE o NO INHERIT base;\n`,
		ATTACH,
	],
	[
		"the partition dropped and made again",
		`${PARENT}${PARTITION}DROP TABLE o;\nCREATE TABLE o (id int, at date NOT NULL);\n`,
		ATTACH,
	],
	[
		"the partition's schema dropped and the partition made again",
		`${PARENT}CREATE SCHEMA s;\nCREATE TABLE s.o (id int, at date NOT NULL, ${BOUND});\nDROP SCHEMA s CASCADE;\nCREATE SCHEMA s;\nCREATE TABLE IF NOT EXISTS s.o (id int, at date NOT NULL);\n`,
		"ALTER TABLE ev ATTACH PARTITION s.o FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');",
	],
	["a partition the history never made", PARENT, ATTACH],
	["a parent with an index", `${PARENT}CREATE INDEX ev_id ON ev (id);\n${PARTITION}`, ATTACH],
	[
		"a parent with a foreign key",
		`CREATE TABLE r (id int PRIMARY KEY);\n${PARENT}ALTER TABLE ev ADD FOREIGN KEY (id) REFERENCES r (id);\n${PARTITION}`,
		ATTACH,
	],
	[
		"a parent made LIKE another",
		`CREATE TABLE tpl (id int, at date NOT NULL);\nCREATE TABLE ev (LIKE tpl INCLUDING ALL) PARTITION BY RANGE (at);\n${PARTITION}`,
		ATTACH,
	],
	[
		"a parent that is itself a partition",
		`CREATE TABLE top (id int, at date NOT NULL) PARTITION BY LIST (id);\nCREATE TABLE ev PARTITION OF top FOR VALUES IN (1) PARTITION BY RANGE (at);\n${PARTITION}`,
		ATTACH,
	],
	[
		"a parent's key column renamed",
		`${PARENT.replace("at)", "at0)").replace("at date", "at0 date")}ALTER TABLE ev RENAME COLUMN at0 TO at;\n${PARTITION}`,
		ATTACH,
	],
	[
		"a key with a COLLATE",
		"CREATE TABLE l (c text NOT NULL) PARTITION BY LIST (c COLLATE \"C\");\nCREATE TABLE o (c text NOT NULL CHECK (c IN ('a')));\n",
		"ALTER TABLE l ATTACH PARTITION o FOR VALUES IN ('a');",
	],
	[
		"a key of two columns",
		"CREATE TABLE n (a int NOT NULL, b int NOT NULL) PARTITION BY RANGE (a, b);\nCREATE TABLE o (a int NOT NULL, b int NOT NULL, CHECK (a >= 0 AND a < 1));\n",
		"ALTER TABLE n ATTACH PARTITION o FOR VALUES FROM (0, 0) TO (1, 0);",
	],
	[
		"a hash key",
		"CREATE TABLE h (k int NOT NULL) PARTITION BY HASH (k);\nCREATE TABLE o (k int NOT NULL CHECK (k >= 0));\n",
		"ALTER TABLE h ATTACH PARTITION o FOR VALUES WITH (MODULUS 2, REMAINDER 0);",
	],
	[
		"a timestamptz key, whose constants read by the session's TimeZone",
		"CREATE TABLE n (t timestamptz NOT NULL) PARTITION BY RANGE (t);\nCREATE TABLE o (t timestamptz NOT NULL CHECK (t >= '2026-01-01' AND t < '2027-01-01'));\n",
		"ALTER TABLE n ATTACH PARTITION o FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');",
	],
	[
		"a date that reads by the session's DateStyle",
		`${plain}ALTER TABLE o ADD CHECK (at >= '01/02/2026' AND at < '2027-01-01');\n`,
		"ALTER TABLE ev ATTACH PARTITION o FOR VALUES FROM ('01/02/2026') TO ('2027-01-01');",
	],
	[
		"an integer key bounded by a string",
		"CREATE TABLE n (k int NOT NULL) PARTITION BY RANGE (k);\nCREATE TABLE o (k int NOT NULL CHECK (k >= '0' AND k < '9'));\n",
		"ALTER TABLE n ATTACH PARTITION o FOR VALUES FROM ('0') TO ('9');",
	],
	[
		"a list with NULL",
		"CREATE TABLE l (c text) PARTITION BY LIST (c);\nCREATE TABLE o (c text NOT NULL CHECK (c IN ('a')));\n",
		"ALTER TABLE l ATTACH PARTITION o FOR VALUES IN ('a', NULL);",
	],
	[
		"a list CHECK past the bound's values",
		"CREATE TABLE l (c text NOT NULL) PARTITION BY LIST (c);\nCREATE TABLE o (c text NOT NULL CHECK (c IN ('a', 'z')));\n",
		"ALTER TABLE l ATTACH PARTITION o FOR VALUES IN ('a', 'b');",
	],
	[
		"a list bound of more values than Postgres's proof reads",
		"CREATE TABLE l (c text NOT NULL) PARTITION BY LIST (c);\nCREATE TABLE o (c text NOT NULL CHECK (c IN ('v0', 'v1')));\n",
		`ALTER TABLE l ATTACH PARTITION o FOR VALUES IN (${values(101).join(", ")});`,
	],
	[
		"a list CHECK of more values than Postgres's proof reads, one value repeated",
		`CREATE TABLE l (c text NOT NULL) PARTITION BY LIST (c);\nCREATE TABLE o (c text NOT NULL CHECK (c IN (${Array.from({ length: 101 }, () => "'a'").join(", ")})));\n`,
		"ALTER TABLE l ATTACH PARTITION o FOR VALUES IN ('a', 'b');",
	],
	[
		"the partition's key and another column swapped by renames",
		"CREATE TABLE ev (at date NOT NULL, x date NOT NULL) PARTITION BY RANGE (at);\nCREATE TABLE o (at date NOT NULL, x date NOT NULL, CHECK (at >= '2026-01-01' AND at < '2027-01-01'));\nALTER TABLE o RENAME COLUMN at TO t;\nALTER TABLE o RENAME COLUMN x TO at;\nALTER TABLE o RENAME COLUMN t TO x;\n",
		ATTACH,
	],
	[
		"the parent's key and another column swapped by renames",
		"CREATE TABLE ev (at date NOT NULL, x date NOT NULL) PARTITION BY RANGE (at);\nALTER TABLE ev RENAME COLUMN at TO t;\nALTER TABLE ev RENAME COLUMN x TO at;\nALTER TABLE ev RENAME COLUMN t TO x;\nCREATE TABLE o (at date NOT NULL, x date NOT NULL, CHECK (at >= '2026-01-01' AND at < '2027-01-01'));\n",
		ATTACH,
	],
	[
		"a parent attached to its own parent by an ATTACH",
		"CREATE TABLE g (at date NOT NULL, k int NOT NULL) PARTITION BY RANGE (k);\nCREATE TABLE ev (at date NOT NULL, k int NOT NULL) PARTITION BY RANGE (at);\nALTER TABLE g ATTACH PARTITION ev FOR VALUES FROM (0) TO (10);\nCREATE TABLE o (at date NOT NULL, k int NOT NULL, CHECK (at >= '2026-01-01' AND at < '2027-01-01'));\n",
		ATTACH,
	],
	/* AE2-1 of r22: a DROP … CASCADE of what another column needs drops that column and the CHECK naming it */
	[
		"a CHECK that also names a column a DROP TYPE … CASCADE drops",
		`${PARENT}CREATE TYPE e AS ENUM ('a');\nCREATE TABLE o (id int, at date NOT NULL, j e, CHECK (at >= '2026-01-01' AND at < '2027-01-01' AND j = 'a'));\nDROP TYPE e CASCADE;\n`,
		ATTACH,
	],
	[
		"a CHECK that also names a column a DROP DOMAIN … CASCADE drops",
		`${PARENT}CREATE DOMAIN d AS int;\nCREATE TABLE o (id int, at date NOT NULL, j d, CHECK (at >= '2026-01-01' AND at < '2027-01-01' AND j = 1));\nDROP DOMAIN d CASCADE;\n`,
		ATTACH,
	],
	[
		"a CHECK that also names a column a DROP SCHEMA … CASCADE drops through its type",
		`${PARENT}CREATE SCHEMA s;\nCREATE DOMAIN s.d AS int;\nCREATE TABLE o (id int, at date NOT NULL, j s.d, CHECK (at >= '2026-01-01' AND at < '2027-01-01' AND j = 1));\nDROP SCHEMA s CASCADE;\n`,
		ATTACH,
	],
	[
		"a CHECK that also names a column a DROP COLLATION … CASCADE drops",
		`${PARENT}CREATE COLLATION cx FROM "C";\nCREATE TABLE o (id int, at date NOT NULL, j text COLLATE cx, CHECK (at >= '2026-01-01' AND at < '2027-01-01' AND j = 'x'));\nDROP COLLATION cx CASCADE;\n`,
		ATTACH,
	],
	[
		"a CHECK that also names a generated column a DROP FUNCTION … CASCADE drops",
		`${PARENT}CREATE FUNCTION g(int) RETURNS int IMMUTABLE LANGUAGE sql AS 'SELECT $1';\nCREATE TABLE o (id int, at date NOT NULL, j int GENERATED ALWAYS AS (g(id)) STORED, CHECK (at >= '2026-01-01' AND at < '2027-01-01' AND j = 1));\nDROP FUNCTION g(int) CASCADE;\n`,
		ATTACH,
	],
	[
		"a CHECK that also names another column",
		`${PARENT}CREATE TABLE o (id int, at date NOT NULL, CHECK (at >= '2026-01-01' AND at < '2027-01-01' AND id > 0));\n`,
		ATTACH,
	],
	[
		"a key with an operator class",
		"CREATE TABLE l (c text NOT NULL) PARTITION BY RANGE (c text_pattern_ops);\nCREATE TABLE o (c text NOT NULL CHECK (c >= 'a' AND c < 'm'));\n",
		"ALTER TABLE l ATTACH PARTITION o FOR VALUES FROM ('a') TO ('m');",
	],
]
