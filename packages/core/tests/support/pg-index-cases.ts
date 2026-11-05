/**
 * The indexes Postgres 17 leaves after each history, under the names it gives them (PA12 of r22b):
 * ChooseIndexName's `pkey`, `key`, `excl` and `idx` over the column names or `expr`, cut to 63 bytes
 * as makeObjectName cuts, and suffixed past a name the schema's relations, or its constraints for a
 * constraint's index, take; each index cloned onto every partition, attached to a matching one, and
 * followed through renames, moves and drops. Each case lists every index as `name on table`, with
 * `partitioned` when its table is (Postgres's relkind I) and `constraint` when a constraint backs it.
 * src/migrate/core/pg-indexes.test.ts holds comb's facts to these lists, and
 * tests/integration/postgres/index-names-oracle.test.ts holds these lists to Postgres 17.
 */

const P =
	"CREATE TABLE p (id int NOT NULL, at date NOT NULL, note text) PARTITION BY RANGE (at);\nCREATE TABLE p1 PARTITION OF p FOR VALUES FROM ('2020-01-01') TO ('2021-01-01');\n"
/* P with its partition partitioned too */
const SUB = P.replace("('2021-01-01');", "('2021-01-01') PARTITION BY LIST (id);")
const LONG = "a".repeat(60)
const WIDE = "é".repeat(31)
const GIST = "CREATE EXTENSION IF NOT EXISTS btree_gist;\n"

/** A history, and every index Postgres leaves after it */
type IndexCase = { history: string; indexes: string[]; label: string }

// lookup-table: each history with the indexes Postgres 17 leaves (.tmp/grunt/p21/pa12/probe.log, probe2.log)
const INDEX_CASES: readonly IndexCase[] = [
	{
		history: P + "CREATE INDEX ON p (at);",
		indexes: ["p1_at_idx on p1", "p_at_idx on p partitioned"],
		label: "an unnamed index",
	},
	{
		history: P + "CREATE INDEX ON p (id, at);",
		indexes: ["p1_id_at_idx on p1", "p_id_at_idx on p partitioned"],
		label: "an index over two columns",
	},
	{
		history: P + "CREATE INDEX ON p ((id + 1));",
		indexes: ["p1_expr_idx on p1", "p_expr_idx on p partitioned"],
		label: "an expression",
	},
	{
		history: P + "CREATE INDEX ON p ((id + 1), (id + 2), id, (id+3));",
		indexes: ["p1_expr_expr1_id_expr2_idx on p1", "p_expr_expr1_id_expr2_idx on p partitioned"],
		label: "expressions numbered past each other and a column",
	},
	{
		history: P + "CREATE INDEX ON p (id, id);",
		indexes: ["p1_id_id1_idx on p1", "p_id_id1_idx on p partitioned"],
		label: "a column twice",
	},
	{
		history: P + "CREATE INDEX ON p (at) INCLUDE (note);",
		indexes: ["p1_at_note_idx on p1", "p_at_note_idx on p partitioned"],
		label: "INCLUDE columns",
	},
	{
		history: P + "CREATE INDEX ON p (note text_pattern_ops DESC, at);",
		indexes: ["p1_note_at_idx on p1", "p_note_at_idx on p partitioned"],
		label: "an operator class and an order",
	},
	{
		history: P + "CREATE UNIQUE INDEX ON p (id, at);",
		indexes: ["p1_id_at_idx on p1", "p_id_at_idx on p partitioned"],
		label: "a unique index",
	},
	{
		history: P + "CREATE TABLE p_at_idx (x int);\nCREATE INDEX ON p (at);",
		indexes: ["p1_at_idx on p1", "p_at_idx1 on p partitioned"],
		label: "a name a table takes",
	},
	{
		history: "CREATE VIEW p_at_idx AS SELECT 1 AS one;\n" + P + "CREATE INDEX ON p (at);",
		indexes: ["p1_at_idx on p1", "p_at_idx1 on p partitioned"],
		label: "a name a view takes",
	},
	{
		history: P + "CREATE TABLE z (at date);\nCREATE INDEX p_at_idx ON z (at);\nCREATE INDEX ON p (at);",
		indexes: ["p1_at_idx on p1", "p_at_idx on z", "p_at_idx1 on p partitioned"],
		label: "a name another table's index takes",
	},
	{
		history: P + "CREATE INDEX ON p (at);\nCREATE INDEX ON p (at);\nCREATE INDEX ON p (at);",
		indexes: [
			"p1_at_idx on p1",
			"p1_at_idx1 on p1",
			"p1_at_idx2 on p1",
			"p_at_idx on p partitioned",
			"p_at_idx1 on p partitioned",
			"p_at_idx2 on p partitioned",
		],
		label: "the same index three times",
	},
	{
		history: P + "ALTER TABLE p ADD PRIMARY KEY (id, at);",
		indexes: ["p1_pkey on p1 constraint", "p_pkey on p partitioned constraint"],
		label: "a primary key",
	},
	{
		history: P + "ALTER TABLE p ADD PRIMARY KEY (id, at) INCLUDE (note);",
		indexes: ["p1_pkey on p1 constraint", "p_pkey on p partitioned constraint"],
		label: "a primary key with INCLUDE",
	},
	{
		history: P + "ALTER TABLE p ADD UNIQUE (id, at);",
		indexes: ["p1_id_at_key on p1 constraint", "p_id_at_key on p partitioned constraint"],
		label: "a unique constraint",
	},
	{
		history: P + "ALTER TABLE p ADD UNIQUE (id, at);\nALTER TABLE p ADD UNIQUE (id, at);",
		indexes: [
			"p1_id_at_key on p1 constraint",
			"p1_id_at_key1 on p1 constraint",
			"p_id_at_key on p partitioned constraint",
			"p_id_at_key1 on p partitioned constraint",
		],
		label: "a unique constraint twice",
	},
	{
		history: GIST + P + "ALTER TABLE p ADD EXCLUDE USING gist (id WITH =, at WITH =);",
		indexes: ["p1_id_at_excl on p1 constraint", "p_id_at_excl on p partitioned constraint"],
		label: "an exclusion constraint",
	},
	{
		history: "CREATE TABLE p (id int, at date, PRIMARY KEY (id, at)) PARTITION BY RANGE (at);",
		indexes: ["p_pkey on p partitioned constraint"],
		label: "a primary key in CREATE TABLE",
	},
	{
		history:
			"CREATE TABLE q (id int PRIMARY KEY, n int UNIQUE, m int);\nCREATE TABLE r (id int, CONSTRAINT r_c UNIQUE (id));",
		indexes: ["q_n_key on q constraint", "q_pkey on q constraint", "r_c on r constraint"],
		label: "column constraints, one named",
	},
	{
		history: "CREATE TABLE p (at date UNIQUE) PARTITION BY RANGE (at);",
		indexes: ["p_at_key on p partitioned constraint"],
		label: "a column's unique on a partitioned table",
	},
	{
		history: `CREATE TABLE ${LONG} (id int, at date) PARTITION BY RANGE (at);\nCREATE INDEX ON ${LONG} (at);\nALTER TABLE ${LONG} ADD PRIMARY KEY (id, at);`,
		indexes: [
			"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_at_idx on aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa partitioned",
			"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_pkey on aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa partitioned constraint",
		],
		label: "a long table",
	},
	{
		history: `CREATE TABLE p (${LONG}x int, at date) PARTITION BY RANGE (at);\nCREATE INDEX ON p (${LONG}x, at);`,
		indexes: ["p_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_idx on p partitioned"],
		label: "a long column",
	},
	{
		history: `CREATE TABLE ${WIDE} (at date) PARTITION BY RANGE (at);\nCREATE INDEX ON ${WIDE} (at);`,
		indexes: ["éééééééééééééééééééééééééééé_at_idx on ééééééééééééééééééééééééééééééé partitioned"],
		label: "a table named in two-byte characters",
	},
	{
		history: 'CREATE TABLE "Ev" ("At" date) PARTITION BY RANGE ("At");\nCREATE INDEX ON "Ev" ("At");',
		indexes: ["Ev_At_idx on Ev partitioned"],
		label: "quoted names",
	},
	{
		history: "CREATE SCHEMA s;\nCREATE TABLE s.p (at date) PARTITION BY RANGE (at);\nCREATE INDEX ON s.p (at);",
		indexes: ["s.p_at_idx on s.p partitioned"],
		label: "another schema",
	},
	{
		history: SUB + "CREATE INDEX ON p (at);\nALTER TABLE p ADD PRIMARY KEY (id, at);\nCREATE INDEX named ON p (id);",
		indexes: [
			"named on p partitioned",
			"p1_at_idx on p1 partitioned",
			"p1_id_idx on p1 partitioned",
			"p1_pkey on p1 partitioned constraint",
			"p_at_idx on p partitioned",
			"p_pkey on p partitioned constraint",
		],
		label: "clones onto a partitioned partition",
	},
	{
		history:
			"CREATE TABLE p (id int, at date) PARTITION BY RANGE (at);\nCREATE INDEX pi ON p (at);\nALTER TABLE p ADD PRIMARY KEY (id, at);\nCREATE TABLE p1 PARTITION OF p FOR VALUES FROM ('2020-01-01') TO ('2021-01-01') PARTITION BY LIST (id);",
		indexes: [
			"p1_at_idx on p1 partitioned",
			"p1_pkey on p1 partitioned constraint",
			"p_pkey on p partitioned constraint",
			"pi on p partitioned",
		],
		label: "a partition made after its parent's indexes",
	},
	{
		history:
			"CREATE TABLE p (id int, at date) PARTITION BY RANGE (at);\nCREATE TABLE p1 PARTITION OF p (PRIMARY KEY (id, at)) FOR VALUES FROM ('2020-01-01') TO ('2021-01-01') PARTITION BY LIST (id);",
		indexes: ["p1_pkey on p1 partitioned constraint"],
		label: "a partition made with its own primary key",
	},
	{
		history:
			"CREATE TABLE p (id int, at date) PARTITION BY RANGE (at);\nCREATE INDEX pi ON p (at);\nCREATE TABLE p1 (id int, at date) PARTITION BY LIST (id);\nCREATE INDEX mine ON p1 (at);\nALTER TABLE p ATTACH PARTITION p1 FOR VALUES FROM ('2020-01-01') TO ('2021-01-01');",
		indexes: ["mine on p1 partitioned", "pi on p partitioned"],
		label: "an attach that finds a matching index",
	},
	{
		history:
			"CREATE TABLE p (id int, at date) PARTITION BY RANGE (at);\nCREATE INDEX pi ON p (at);\nCREATE TABLE p1 (id int, at date) PARTITION BY LIST (id);\nALTER TABLE p ATTACH PARTITION p1 FOR VALUES FROM ('2020-01-01') TO ('2021-01-01');",
		indexes: ["p1_at_idx on p1 partitioned", "pi on p partitioned"],
		label: "an attach that finds none",
	},
	{
		history:
			"CREATE TABLE p (id int, at date) PARTITION BY RANGE (at);\nCREATE INDEX ON p (at);\nCREATE TABLE c (id int, at date) PARTITION BY LIST (id);\nCREATE TABLE c1 PARTITION OF c FOR VALUES IN (1);\nALTER TABLE p ATTACH PARTITION c FOR VALUES FROM ('2020-01-01') TO ('2021-01-01');",
		indexes: ["c1_at_idx on c1", "c_at_idx on c partitioned", "p_at_idx on p partitioned"],
		label: "an attach of a partitioned table with partitions",
	},
	{
		history:
			"CREATE TABLE p (id int, at date, PRIMARY KEY (id, at)) PARTITION BY RANGE (at);\nCREATE TABLE p1 (id int NOT NULL, at date NOT NULL, UNIQUE (id, at));\nALTER TABLE p ATTACH PARTITION p1 FOR VALUES FROM ('2020-01-01') TO ('2021-01-01');",
		indexes: ["p1_id_at_key on p1 constraint", "p1_pkey on p1 constraint", "p_pkey on p partitioned constraint"],
		label: "an attach that wants a constraint of the same kind",
	},
	{
		history:
			"CREATE TABLE p (id int, at date) PARTITION BY RANGE (at);\nCREATE TABLE p1 (id int, at date, UNIQUE (id, at));\nALTER TABLE p ADD UNIQUE (id, at);\nALTER TABLE p ATTACH PARTITION p1 FOR VALUES FROM ('2020-01-01') TO ('2021-01-01');",
		indexes: ["p1_id_at_key on p1 constraint", "p_id_at_key on p partitioned constraint"],
		label: "an attach that finds a unique constraint",
	},
	{
		history:
			"CREATE TABLE p (id int, at date) PARTITION BY RANGE (at);\nCREATE TABLE p1 (id int, at date);\nCREATE UNIQUE INDEX m ON p1 (id, at);\nALTER TABLE p ADD UNIQUE (id, at);\nALTER TABLE p ATTACH PARTITION p1 FOR VALUES FROM ('2020-01-01') TO ('2021-01-01');",
		indexes: ["m on p1", "p1_id_at_key on p1 constraint", "p_id_at_key on p partitioned constraint"],
		label: "an attach that passes a plain index for a constraint",
	},
	{
		history: SUB + "CREATE INDEX mine ON p1 (at);\nCREATE INDEX ON p (at);",
		indexes: ["mine on p1 partitioned", "p_at_idx on p partitioned"],
		label: "an index on a parent whose partition has a match",
	},
	{
		history: P + "ALTER TABLE p1 ADD UNIQUE (id, at);\nALTER TABLE p ADD PRIMARY KEY (id, at);",
		indexes: ["p1_id_at_key on p1 constraint", "p_pkey on p partitioned constraint"],
		label: "a primary key on a parent whose partition has a unique constraint",
	},
	{
		history: P + "CREATE INDEX a ON p (at);\nCREATE INDEX b ON p (at);",
		indexes: ["a on p partitioned", "b on p partitioned", "p1_at_idx on p1", "p1_at_idx1 on p1"],
		label: "a second index past an attached match",
	},
	{
		history: P + "CREATE INDEX ON ONLY p (at);",
		indexes: ["p_at_idx on p partitioned"],
		label: "an index ON ONLY a parent",
	},
	{
		history:
			P +
			"CREATE INDEX pi ON ONLY p (at);\nCREATE INDEX c ON p1 (at);\nALTER INDEX pi ATTACH PARTITION c;\nDROP INDEX pi;\nCREATE INDEX ON p1 (at);",
		indexes: ["p1_at_idx on p1"],
		label: "an index attached by ALTER INDEX, dropped with its parent",
	},
	{
		history: P + "CREATE INDEX ON p (at);\nDROP INDEX p_at_idx;\nCREATE INDEX ON p1 (at);",
		indexes: ["p1_at_idx on p1"],
		label: "a parent's index dropped with its clones",
	},
	{
		history:
			P + "CREATE INDEX ON p (at);\nALTER TABLE p DETACH PARTITION p1;\nCREATE INDEX ON p (id);\nDROP INDEX p_at_idx;",
		indexes: ["p1_at_idx on p1", "p_id_idx on p partitioned"],
		label: "a partition detached keeps its index",
	},
	{
		history:
			P +
			"CREATE INDEX ON p (at);\nDROP TABLE p;\nCREATE TABLE p (id int, at date) PARTITION BY RANGE (at);\nCREATE TABLE p1 (id int, at date);\nCREATE INDEX ON p1 (at);\nCREATE INDEX ON p (at);",
		indexes: ["p1_at_idx on p1", "p_at_idx on p partitioned"],
		label: "a partitioned table dropped with its partitions, then made again",
	},
	{
		history: P + "ALTER TABLE p ADD CONSTRAINT p_u UNIQUE (id, at);\nALTER TABLE p RENAME CONSTRAINT p_u TO p_v;",
		indexes: ["p1_id_at_key on p1 constraint", "p_v on p partitioned constraint"],
		label: "a constraint renamed",
	},
	{
		history:
			"CREATE TABLE t (id int);\nCREATE INDEX x ON t (id);\nALTER TABLE t ADD CONSTRAINT x CHECK (id > 0);\nALTER TABLE t RENAME CONSTRAINT x TO y;",
		indexes: ["x on t"],
		label: "a CHECK renamed that shares an index's name",
	},
	{
		history:
			P +
			"ALTER TABLE p ADD PRIMARY KEY (id, at);\nALTER INDEX p_pkey RENAME TO p_key;\nALTER TABLE p DROP CONSTRAINT p_key;\nALTER TABLE p ADD PRIMARY KEY (id, at);",
		indexes: ["p1_pkey on p1 constraint", "p_pkey on p partitioned constraint"],
		label: "a key index renamed, then its constraint dropped and added again",
	},
	{
		history:
			P +
			"ALTER TABLE p ADD PRIMARY KEY (id, at);\nALTER TABLE p DROP CONSTRAINT p_pkey;\nALTER TABLE p ADD PRIMARY KEY (id, at);",
		indexes: ["p1_pkey on p1 constraint", "p_pkey on p partitioned constraint"],
		label: "a constraint dropped and added again",
	},
	{
		history:
			"CREATE TABLE t (id int NOT NULL);\nCREATE UNIQUE INDEX i ON t (id);\nALTER TABLE t ADD CONSTRAINT t_k UNIQUE USING INDEX i;",
		indexes: ["t_k on t constraint"],
		label: "ADD … USING INDEX renames the index",
	},
	{
		history:
			"CREATE TABLE s (id int PRIMARY KEY, at date);\nCREATE INDEX ON s (at);\nCREATE TABLE p (LIKE s INCLUDING INDEXES) PARTITION BY RANGE (id);",
		indexes: [
			"p_at_idx on p partitioned",
			"p_pkey on p partitioned constraint",
			"s_at_idx on s",
			"s_pkey on s constraint",
		],
		label: "LIKE … INCLUDING INDEXES",
	},
	{
		history:
			"CREATE TABLE s (id int CONSTRAINT s_named UNIQUE, at date, CONSTRAINT s_p PRIMARY KEY (id));\nCREATE INDEX s_plain ON s (at);\nCREATE TABLE p (n int UNIQUE, LIKE s INCLUDING INDEXES, UNIQUE (id));",
		indexes: [
			"p_at_idx on p",
			"p_id_key on p constraint",
			"p_n_key on p constraint",
			"p_pkey on p constraint",
			"s_p on s constraint",
			"s_plain on s",
		],
		label: "LIKE after the table's own constraints",
	},
	{
		history: "CREATE TABLE q (UNIQUE (n), n int UNIQUE, m int, UNIQUE (n));",
		indexes: ["q_n_key on q constraint"],
		label: "the same constraint written three ways",
	},
	{
		history: "CREATE TABLE t (id int UNIQUE PRIMARY KEY);",
		indexes: ["t_pkey on t constraint"],
		label: "a unique constraint the primary key covers",
	},
	{
		history: "CREATE TABLE t (id int UNIQUE, CONSTRAINT named UNIQUE (id));",
		indexes: ["named on t constraint"],
		label: "a named constraint merged into an unnamed one",
	},
	{
		history: GIST + "CREATE TABLE e (id int, EXCLUDE USING gist (id WITH =), EXCLUDE USING gist (id WITH =));",
		indexes: ["e_id_excl on e constraint"],
		label: "exclusion constraints merged",
	},
	{
		history: "CREATE TABLE t (id int);\nALTER TABLE t ADD COLUMN n int UNIQUE, ADD UNIQUE (n);",
		indexes: ["t_n_key on t constraint", "t_n_key1 on t constraint"],
		label: "a column added with its constraint",
	},
	{
		history:
			"CREATE TABLE r (id int PRIMARY KEY);\nCREATE TABLE p (id int CONSTRAINT p_id_key REFERENCES r);\nALTER TABLE p ADD UNIQUE (id);",
		indexes: ["p_id_key1 on p constraint", "r_pkey on r constraint"],
		label: "a name a foreign key takes",
	},
	{
		history: "CREATE TABLE a (id int PRIMARY KEY);\nCREATE TABLE b () INHERITS (a);\nCREATE INDEX ON b (id);",
		indexes: ["a_pkey on a constraint", "b_id_idx on b"],
		label: "an inheriting table copies no index",
	},
	{
		history:
			"CREATE TABLE p (id int, at date, n int) PARTITION BY RANGE (at);\nCREATE INDEX ON p (n);\nCREATE INDEX ON p ((n + 1));\nCREATE INDEX ON p (id) WHERE n > 0;\nALTER TABLE p DROP COLUMN n;\nCREATE INDEX ON p (id);",
		indexes: ["p_id_idx on p partitioned"],
		label: "a dropped column takes its indexes",
	},
	{
		history:
			P +
			"ALTER TABLE p ADD COLUMN n int;\nCREATE INDEX ON p (n);\nALTER TABLE p DROP COLUMN n;\nCREATE INDEX ON p1 (id);",
		indexes: ["p1_id_idx on p1"],
		label: "a dropped column takes its partitions' indexes",
	},
	{
		history: P + 'CREATE INDEX ON p (at);\nALTER TABLE p RENAME COLUMN at TO "when";\nCREATE INDEX ON p ("when");',
		indexes: ["p1_at_idx on p1", "p1_when_idx on p1", "p_at_idx on p partitioned", "p_when_idx on p partitioned"],
		label: "a renamed column names the next index",
	},
	{
		history:
			P +
			"CREATE INDEX ON p (at);\nALTER TABLE p RENAME COLUMN at TO \"when\";\nCREATE TABLE p2 PARTITION OF p FOR VALUES FROM ('2021-01-01') TO ('2022-01-01');",
		indexes: ["p1_at_idx on p1", "p2_at_idx on p2", "p_at_idx on p partitioned"],
		label: "a renamed column names a new partition's clone",
	},
	{
		history: P + "CREATE INDEX ON p (at);\nALTER TABLE p RENAME TO q;\nCREATE INDEX ON q (at);",
		indexes: ["p1_at_idx on p1", "p1_at_idx1 on p1", "p_at_idx on q partitioned", "q_at_idx on q partitioned"],
		label: "a table renamed keeps its indexes",
	},
	{
		history:
			"CREATE SCHEMA s;\n" + P + "CREATE INDEX ON p (at);\nALTER TABLE p SET SCHEMA s;\nCREATE INDEX ON s.p (id);",
		indexes: ["p1_at_idx on p1", "p1_id_idx on p1", "s.p_at_idx on s.p partitioned", "s.p_id_idx on s.p partitioned"],
		label: "a table moved takes its indexes",
	},
	{
		history: P + "CREATE INDEX i ON p (at);\nCREATE INDEX IF NOT EXISTS i ON p (id);",
		indexes: ["i on p partitioned", "p1_at_idx on p1"],
		label: "IF NOT EXISTS on a taken name",
	},
	{
		history: "CREATE TABLE t (id int PRIMARY KEY);\nCREATE TABLE IF NOT EXISTS t (id int UNIQUE);",
		indexes: ["t_pkey on t constraint"],
		label: "CREATE TABLE IF NOT EXISTS of a table there",
	},
	{
		history: "CREATE TABLE t (n int);\nALTER TABLE t ADD UNIQUE (n), ADD UNIQUE (n);",
		indexes: ["t_n_key on t constraint", "t_n_key1 on t constraint"],
		label: "two subcommands' constraints kept apart",
	},
	{
		history:
			'CREATE TABLE p (id int, at date) PARTITION BY RANGE (at);\nCREATE INDEX ON p (at);\nALTER TABLE p RENAME COLUMN at TO "when";\nCREATE TABLE c (id int, "when" date);\nCREATE INDEX mine ON c ("when");\nALTER TABLE p ATTACH PARTITION c FOR VALUES FROM (\'2020-01-01\') TO (\'2021-01-01\');',
		indexes: ["mine on c", "p_at_idx on p partitioned"],
		label: "an attach matches a renamed column",
	},
	{
		history:
			P +
			"CREATE INDEX ON p ((id + length(note))) WHERE note IS NOT NULL;\nALTER TABLE p RENAME COLUMN note TO memo;\nCREATE TABLE p2 (id int NOT NULL, at date NOT NULL, memo text);\nCREATE INDEX p2_x ON p2 ((id + length(memo))) WHERE memo IS NOT NULL;\nALTER TABLE p ATTACH PARTITION p2 FOR VALUES FROM ('2021-01-01') TO ('2022-01-01');",
		indexes: ["p1_expr_idx on p1", "p2_x on p2", "p_expr_idx on p partitioned"],
		label: "an attach matches an expression and predicate over a renamed column",
	},
	{
		history:
			P +
			"CREATE INDEX ON p (at) INCLUDE (note, id);\nALTER TABLE p RENAME COLUMN note TO memo;\nCREATE TABLE p2 (id int NOT NULL, at date NOT NULL, memo text);\nCREATE INDEX p2_x ON p2 (at) INCLUDE (memo, id);\nALTER TABLE p ATTACH PARTITION p2 FOR VALUES FROM ('2021-01-01') TO ('2022-01-01');",
		indexes: ["p1_at_note_id_idx on p1", "p2_x on p2", "p_at_note_id_idx on p partitioned"],
		label: "an attach matches an included column renamed beside one kept",
	},
	{
		history: P + "CREATE INDEX ON p (at);\nALTER TABLE p_at_idx RENAME TO p_when;",
		indexes: ["p1_at_idx on p1", "p_when on p partitioned"],
		label: "an index renamed by ALTER TABLE",
	},
	{
		history: P + "CREATE INDEX mine ON p1 (id);\nCREATE INDEX ON p (at);\nALTER TABLE p DETACH PARTITION p1;",
		indexes: ["mine on p1", "p1_at_idx on p1", "p_at_idx on p partitioned"],
		label: "a detach keeps a partition's own index",
	},
	{
		history: P + "CREATE INDEX ON p (at);\nALTER TABLE p DETACH PARTITION p1;\nDROP TABLE p;",
		indexes: ["p1_at_idx on p1"],
		label: "a partition detached outlives its old parent",
	},
	{
		history: P + "DROP TABLE p;\nCREATE TABLE IF NOT EXISTS p1 (id int PRIMARY KEY);",
		indexes: ["p1_pkey on p1 constraint"],
		label: "a partition dropped with its parent",
	},
	{
		history:
			SUB +
			"CREATE TABLE p1a PARTITION OF p1 FOR VALUES IN (1);\nDROP TABLE p;\nCREATE TABLE IF NOT EXISTS p1a (id int PRIMARY KEY);",
		indexes: ["p1a_pkey on p1a constraint"],
		label: "a partition's partition dropped with its grandparent",
	},
]

export { INDEX_CASES, type IndexCase }
