/**
 * PA1 of r22b as comb-9d reversed it: no reading of a Postgres file proves what it leaves on its
 * session. A partition's or a parent's trigger, default or check, a LIKE copy's default, a TRUNCATE
 * CASCADE's trigger, a SELECT INTO TEMP or a pg_temp function, a DO block's EXECUTE, an overload
 * the target holds and a nextval a later default reads each carried one file's session into the
 * next while comb batched files it had read as harmless (r22 area E, AE1 to AE5 and four mutant
 * shapes). Each file now gets an Atlas call, and the check replay a session, of its own, so one apply
 * of every file ends as applying them one at a time does, and so does one check.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { approveMigration } from "../../../src/migrate/core/approval.ts"
import { applyWithAtlas } from "../../../src/migrate/core/atlas-apply.ts"
import { hashDir } from "../../../src/migrate/core/atlas-dir.ts"
import { loadPostgresParser } from "../../../src/migrate/core/pg-parser.ts"
import { run } from "../../../src/migrate/core/process.ts"
import type { ParsedMigration } from "../../../src/migrate/types.ts"
import { withScratchDb } from "../support/pg.ts"
import { query } from "../support/pg-roles.ts"

beforeAll(loadPostgresParser)

let dir = ""
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "comb-pg-session-leaks-"))
})
afterEach(() => rmSync(dir, { force: true, recursive: true }))

/** The first `count` of `files` alone in the directory, named in order, each allowed past comb's rating, and hashed */
async function write(files: readonly string[], count = files.length): Promise<void> {
	rmSync(dir, { force: true, recursive: true })
	dir = mkdtempSync(join(tmpdir(), "comb-pg-session-leaks-"))
	files
		.slice(0, count)
		.forEach((sql, i) =>
			writeFileSync(
				join(dir, `2026010${i + 1}000000_f${i}.sql`),
				`-- comb:allow-unsafe: the test reads the session\n${sql}\n`,
			),
		)
	await hashDir(run, dir)
}

/** The options of a run against `url`, approving every file, with a 5 s lockTimeout */
const options = (devUrl: string, url: string, checkOnly = false) => ({
	approve: (m: ParsedMigration) => approveMigration(m, { target: "core", yes: true }),
	checkOnly,
	dir,
	print: () => undefined,
	target: { devUrl, lockTimeout: "5s", schema: "public", url },
})

/* code that sets app.mark for the rest of its session, as a trigger, a function and a trigger that returns nothing */
const SETS_MARK = "PERFORM set_config('app.mark', 'leaked', false)"
const MARK = `CREATE FUNCTION mark() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${SETS_MARK}; RETURN NEW; END $$;`
const STAMP = `CREATE FUNCTION stamp() RETURNS int LANGUAGE plpgsql AS $$ BEGIN ${SETS_MARK}; RETURN 1; END $$;`
/* the last file of most cases: it fails once an earlier file's code set app.mark on its session */
const GUARD = `DO $$ BEGIN IF current_setting('app.mark', true) = 'leaked' THEN RAISE EXCEPTION 'leaked'; END IF; END $$;`

type Case = {
	files: readonly string[]
	/** made by hand on the target once the first file applied: code no file shows, so no check replays it */
	hand?: string
}

// lookup-table: each shape a file's session reached the next by, under the finding that found it
const CASES: Readonly<Record<string, Case>> = {
	/* AE1: a partitioned parent's trigger is cloned onto its partitions */
	"a partitioned parent's trigger, by an insert into its partition": {
		files: [
			`CREATE TABLE p (x int) PARTITION BY RANGE (x); CREATE TABLE c PARTITION OF p FOR VALUES FROM (0) TO (100); ${MARK} CREATE TRIGGER tr BEFORE INSERT ON p FOR EACH ROW EXECUTE FUNCTION mark();`,
			"INSERT INTO c VALUES (1);",
			GUARD,
		],
	},
	"a partitioned parent's default, by an insert into its partition": {
		files: [
			`${STAMP} CREATE TABLE p (x int, y int DEFAULT stamp()) PARTITION BY RANGE (x); CREATE TABLE c PARTITION OF p FOR VALUES FROM (0) TO (100);`,
			"INSERT INTO c (x) VALUES (1);",
			GUARD,
		],
	},
	"an inheritance parent's check, by an insert into its child": {
		files: [
			`${STAMP} CREATE TABLE p (x int CHECK (stamp() = 1)); CREATE TABLE c () INHERITS (p);`,
			"INSERT INTO c VALUES (1);",
			GUARD,
		],
	},
	"a LIKE source's default, by an insert into its copy": {
		files: [
			`${STAMP} CREATE TABLE src (x int, y int DEFAULT stamp()); CREATE TABLE copy (LIKE src INCLUDING ALL);`,
			"INSERT INTO copy (x) VALUES (1);",
			GUARD,
		],
	},
	"a referencing table's TRUNCATE trigger, by a TRUNCATE CASCADE of the table it references": {
		files: [
			`CREATE TABLE b (id int PRIMARY KEY); CREATE TABLE a (b int REFERENCES b); ${MARK.replace("RETURN NEW", "RETURN NULL")} CREATE TRIGGER tr BEFORE TRUNCATE ON a FOR EACH STATEMENT EXECUTE FUNCTION mark();`,
			"TRUNCATE b CASCADE;",
			GUARD,
		],
	},
	/* AE2: a temp object made outside CREATE TEMP */
	"a temp table SELECT INTO makes, which shadows a table of the schema": {
		files: [
			"CREATE TABLE src (v text); INSERT INTO src VALUES ('permanent');",
			"SELECT 'temp'::text AS v INTO TEMP src;",
			"DO $$ BEGIN IF (SELECT v FROM src) <> 'permanent' THEN RAISE EXCEPTION 'leaked'; END IF; END $$;",
		],
	},
	"a function made in pg_temp": {
		files: [
			"CREATE TABLE seen (v text);",
			"CREATE FUNCTION pg_temp.tag() RETURNS text LANGUAGE sql AS $$ SELECT 'temp'::text $$;",
			"INSERT INTO seen SELECT pg_temp.tag();",
		],
	},
	/* AE3: code a DO block's EXECUTE makes, which no file spells */
	"a trigger a DO block makes, by an insert into its table": {
		files: [
			`CREATE TABLE t (x int); ${MARK}`,
			"DO $$ BEGIN EXECUTE 'CREATE TRIGGER tr BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION mark()'; END $$;",
			"INSERT INTO t VALUES (1);",
			GUARD,
		],
	},
	/* AE4: an overload only the target holds */
	"a plpgsql overload the target holds beside a LANGUAGE sql one": {
		files: ["CREATE TABLE seen (v text);", "CREATE TABLE n AS SELECT touch(1) AS v;", GUARD],
		hand: `CREATE FUNCTION touch(i int) RETURNS int LANGUAGE plpgsql AS $$ BEGIN ${SETS_MARK}; RETURN i; END $$; CREATE FUNCTION touch(t text) RETURNS text LANGUAGE sql AS $$ SELECT t $$;`,
	},
	/* AE5: what a nextval leaves, read by a later file's default */
	"a nextval a later file's currval default reads": {
		files: [
			"CREATE SEQUENCE s; CREATE TABLE t (x bigint DEFAULT currval('s'));",
			"SELECT nextval('s');",
			"INSERT INTO t DEFAULT VALUES;",
		],
	},
	/* the four mutant shapes no PA1 suite killed (AE10 to AE13) */
	"a plpgsql overload a file defines beside a LANGUAGE sql one": {
		files: [
			`CREATE FUNCTION f(i int) RETURNS int LANGUAGE plpgsql AS $$ BEGIN ${SETS_MARK}; RETURN i; END $$; CREATE FUNCTION f(t text) RETURNS text LANGUAGE sql AS $$ SELECT t $$;`,
			"SELECT f(1);",
			GUARD,
		],
	},
	"a referencing table's trigger, by an update ON UPDATE CASCADE carries": {
		files: [
			`CREATE TABLE b (id int PRIMARY KEY); INSERT INTO b VALUES (1); CREATE TABLE a (b int REFERENCES b ON UPDATE CASCADE); INSERT INTO a VALUES (1); ${MARK} CREATE TRIGGER tr BEFORE UPDATE ON a FOR EACH ROW EXECUTE FUNCTION mark();`,
			"UPDATE b SET id = 2;",
			GUARD,
		],
	},
	"an ALTER EXTENSION … UPDATE, which runs the extension's script": {
		files: ["CREATE TABLE t (x int);", "ALTER EXTENSION plpgsql UPDATE;", GUARD],
	},
	"an operator class's support function, by an insert into a table it indexes": {
		files: [
			`CREATE TABLE t (x int); CREATE FUNCTION c(int, int) RETURNS int LANGUAGE plpgsql AS $$ BEGIN ${SETS_MARK}; RETURN btint4cmp($1, $2); END $$; CREATE OPERATOR CLASS marks FOR TYPE int USING btree AS OPERATOR 1 <, OPERATOR 2 <=, OPERATOR 3 =, OPERATOR 4 >=, OPERATOR 5 >, FUNCTION 1 c(int, int); CREATE INDEX ON t (x marks);`,
			"INSERT INTO t VALUES (1);",
			"INSERT INTO t VALUES (2);",
			GUARD,
		],
	},
}

/* how a run's end reads: what Postgres said, without comb's or Atlas's own words around it */
const SAID = [
	"leaked",
	'schema "pg_temp" does not exist',
	'currval of sequence "s" is not yet defined in this session',
] as const

/** How `body` ended: "ok", or the one Postgres message of SAID its error holds, or its whole message */
async function ending(body: () => Promise<unknown>): Promise<string> {
	try {
		await body()
		return "ok"
	} catch (error) {
		const message = (error as Error).message
		return SAID.find((said) => message.includes(said)) ?? message
	}
}

/** One apply of each file in turn (`alone`), or of the first and then of every file at once */
async function applied({ files, hand }: Case, alone: boolean): Promise<string> {
	return withScratchDb((dev) =>
		withScratchDb((url) =>
			ending(async () => {
				await write(files, 1)
				await applyWithAtlas(options(dev, url))
				if (hand !== undefined) await query(url, hand)
				for (let count = alone ? 2 : files.length; count <= files.length; count++) {
					await write(files, count)
					await applyWithAtlas(options(dev, url))
				}
			}),
		),
	)
}

/** One check of every file, on a target with none applied */
async function checked({ files }: Case): Promise<string> {
	await write(files)
	return withScratchDb((dev) => withScratchDb((url) => ending(() => applyWithAtlas(options(dev, url, true)))))
}

describe("one apply, or one check, of every file ends as applying them one at a time does (PA1 reversed; AE1 to AE5, AE10 to AE13)", () => {
	it.each(Object.keys(CASES))(
		"%s",
		async (name) => {
			const shape = CASES[name] as Case
			const alone = await applied(shape, true)
			const together = [await applied(shape, false), shape.hand === undefined ? await checked(shape) : alone]
			expect(together).toEqual([alone, alone])
		},
		180_000,
	)
})
