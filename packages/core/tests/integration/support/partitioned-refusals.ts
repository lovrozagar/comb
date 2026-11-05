/**
 * Each statement Postgres refuses inside a transaction block for a partitioned table or index
 * (REINDEX, CLUSTER), or runs there for a plain one, after its history: index-names-oracle.test.ts
 * holds comb's rating to Postgres 17, and check-partitioned.test.ts holds check's replay to it.
 */

export const P = [
	"CREATE TABLE p (id int NOT NULL, at date NOT NULL) PARTITION BY RANGE (at);",
	"CREATE TABLE p1 PARTITION OF p FOR VALUES FROM ('2020-01-01') TO ('2021-01-01');",
	"",
].join("\n")

// lookup-table: r22b's partitioned-facts repro, each history and the statement run after it in a transaction block
export const REFUSALS: ReadonlyArray<readonly [string, string, string]> = [
	["a named index on p", `${P}CREATE INDEX p_at ON p (at);`, "REINDEX INDEX p_at"],
	["an unnamed index on p", `${P}CREATE INDEX ON p (at);`, "REINDEX INDEX p_at_idx"],
	["p's primary key", `${P}ALTER TABLE p ADD PRIMARY KEY (id, at);`, "REINDEX INDEX p_pkey"],
	[
		"p's inline primary key",
		"CREATE TABLE p (id int, at date, PRIMARY KEY (id, at)) PARTITION BY RANGE (at);",
		"REINDEX INDEX p_pkey",
	],
	["p's unnamed unique constraint", `${P}ALTER TABLE p ADD UNIQUE (id, at);`, "REINDEX INDEX p_id_at_key"],
	["p's named unique constraint", `${P}ALTER TABLE p ADD CONSTRAINT p_u UNIQUE (id, at);`, "REINDEX INDEX p_u"],
	["p clustered on its primary key", `${P}ALTER TABLE p ADD PRIMARY KEY (id, at);`, "CLUSTER p USING p_pkey"],
	[
		"a partition partitioned in turn",
		P.replace("('2021-01-01');", "('2021-01-01') PARTITION BY LIST (id);"),
		"REINDEX TABLE p1",
	],
	["a plain partition", P, "REINDEX TABLE p1"],
	["an index renamed", `${P}CREATE INDEX p_at ON p (at);\nALTER INDEX p_at RENAME TO p_when;`, "REINDEX INDEX p_when"],
	["a table renamed", `${P}ALTER TABLE p RENAME TO q;`, "REINDEX TABLE q"],
	["a plain table made where p was dropped", `${P}DROP TABLE p;\nCREATE TABLE p (id int);`, "REINDEX TABLE p"],
	[
		"a plain table made where p was renamed away",
		`${P}ALTER TABLE p RENAME TO q;\nCREATE TABLE p (id int);`,
		"REINDEX TABLE p",
	],
	[
		"a plain index made where a partitioned one was dropped",
		`${P}CREATE INDEX p_at ON p (at);\nCREATE TABLE z (at date);\nDROP INDEX p_at;\nCREATE INDEX p_at ON z (at);`,
		"REINDEX INDEX p_at",
	],
	[
		"a table made IF NOT EXISTS",
		"CREATE TABLE IF NOT EXISTS p (id int, at date) PARTITION BY RANGE (at);",
		"REINDEX TABLE p",
	],
	[
		"a table made LIKE another",
		"CREATE TABLE src (id int, at date);\nCREATE TABLE p (LIKE src) PARTITION BY RANGE (at);",
		"REINDEX TABLE p",
	],
	["an index made ON ONLY p", `${P}CREATE INDEX p_at ON ONLY p (at);`, "REINDEX INDEX p_at"],
	["a quoted mixed-case table", 'CREATE TABLE "Ev" (at date) PARTITION BY RANGE (at);', 'REINDEX TABLE "Ev"'],
	["a REINDEX with options", P, "REINDEX (VERBOSE) TABLE p"],
]
