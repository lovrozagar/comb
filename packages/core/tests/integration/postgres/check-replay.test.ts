/**
 * P13 of r19: a retype of a column a view reads passed check, then failed on every apply, because
 * Postgres refuses it ("cannot alter type of a column used by a view or rule"). Check now replays the
 * history and the pending files on a postgres:// devUrl in one transaction it rolls back, so Postgres
 * decides: each kind of dependent its probe found refusing the retype stops check with Postgres's
 * message, each it found allowing it passes, and a statement only `-- atlas:txmode none` can run is
 * left out of the replay and named.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pg from "pg"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { approveMigration } from "../../../src/migrate/core/approval.ts"
import { applyWithAtlas } from "../../../src/migrate/core/atlas-apply.ts"
import { hashDir } from "../../../src/migrate/core/atlas-dir.ts"
import { loadPostgresParser } from "../../../src/migrate/core/pg-parser.ts"
import { run } from "../../../src/migrate/core/process.ts"
import type { ParsedMigration } from "../../../src/migrate/types.ts"
import { pgUrl, withScratchDb } from "../support/pg.ts"
import { asRole, dropRoles, heldRole, hiddenWrites, query, roleOf, shapeRoles, unique } from "../support/pg-roles.ts"

beforeAll(loadPostgresParser)

let dir = ""
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "comb-pg-check-replay-"))
})
afterEach(() => rmSync(dir, { force: true, recursive: true }))

/** Run `sql` on the database at `url` */
async function exec(url: string, sql: string): Promise<void> {
	const client = new pg.Client({ connectionString: url })
	await client.connect()
	try {
		await client.query(sql)
	} finally {
		await client.end()
	}
}

/** A scratch database held from the file's first test to its last: its URL, inside a test */
function heldScratchDb(): () => string {
	const held = { release: () => undefined as void, url: "" }
	let dropped: Promise<void> = Promise.resolve()
	beforeAll(
		() =>
			new Promise<void>((ready) => {
				dropped = withScratchDb(
					(url) =>
						new Promise<void>((release) => {
							Object.assign(held, { release, url })
							ready()
						}),
				)
			}),
	)
	afterAll(async () => {
		held.release()
		await dropped
	})
	return () => held.url
}

/* one dev and one target for every check: the replay rolls back on dev, and a check of a target with no history writes nothing */
const devUrl = heldScratchDb()
const targetUrl = heldScratchDb()

const T =
	"CREATE TABLE t (id int PRIMARY KEY, v varchar(10), w int);\nCREATE TABLE u (id int PRIMARY KEY, v varchar(10));\n"
const RETYPE = "ALTER TABLE t ALTER COLUMN v TYPE varchar(20);\n"

/** The options a check of the directory against `target` takes, collecting what it prints in `out` */
const options = (target: { devUrl: string; url: string }, out: string[]) => ({
	approve: (m: ParsedMigration) => approveMigration(m, { target: "core", yes: true }),
	dir,
	print: (line: string) => out.push(line),
	target: { ...target, lockTimeout: "5s", schema: "public" },
})

/** `one` then `two`, written and hashed: a history of `one` with `two` pending, as check replays them */
function files(one: string, two: string): void {
	/* CREATE STATISTICS is a kind comb does not rate: the history's own approval lets it pass */
	writeFileSync(join(dir, "20260101000000_one.sql"), `-- comb:allow-unsafe: the test's history\n${one}`)
	writeFileSync(join(dir, "20260102000000_two.sql"), two)
	hashDir(run, dir)
}

/** `one` then `two` checked on the shared target, replayed on `dev`: what check printed, or why it refused */
async function checked(
	one: string,
	two: string,
	dev = devUrl(),
): Promise<{ out: string[]; refused?: string | undefined }> {
	files(one, two)
	const out: string[] = []
	try {
		await applyWithAtlas({ ...options({ devUrl: dev, url: targetUrl() }, out), checkOnly: true })
		return { out }
	} catch (error) {
		return { out, refused: (error as Error).message }
	}
}

describe("check of a retype Postgres refuses on every database (P13 of r19)", () => {
	it.each([
		["a view", "CREATE VIEW x AS SELECT v FROM t;\n", "used by a view or rule"],
		["a view through t.*", "CREATE VIEW x AS SELECT * FROM t;\n", "used by a view or rule"],
		[
			"a view through an alias in a join",
			"CREATE VIEW x AS SELECT a.v FROM t a JOIN u b ON a.id = b.id;\n",
			"used by a view or rule",
		],
		["a materialized view", "CREATE MATERIALIZED VIEW x AS SELECT v FROM t;\n", "used by a view or rule"],
		[
			"a rule",
			"CREATE TABLE l (v text);\nCREATE RULE r AS ON UPDATE TO t DO ALSO INSERT INTO l VALUES (NEW.v);\n",
			"used by a view or rule",
		],
		["a policy", "CREATE POLICY p ON t USING (v <> '');\n", "used in a policy definition"],
		[
			"a trigger's WHEN",
			"CREATE FUNCTION tf() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$;\nCREATE TRIGGER tr BEFORE UPDATE ON t FOR EACH ROW WHEN (NEW.v <> '') EXECUTE FUNCTION tf();\n",
			"used in a trigger definition",
		],
		[
			"a generated column",
			"ALTER TABLE t ADD COLUMN g text GENERATED ALWAYS AS (v || 'x') STORED;\n",
			"used by a generated column",
		],
		[
			"a BEGIN ATOMIC function",
			"CREATE FUNCTION n() RETURNS bigint LANGUAGE sql BEGIN ATOMIC SELECT count(v) FROM t; END;\n",
			"used by a function or procedure",
		],
	])("refuses one of a column %s reads, with Postgres's own message", async (_, dependent, said) => {
		const { refused } = await checked(`${T}${dependent}`, RETYPE)
		expect(refused).toContain(
			`20260102000000_two.sql: devUrl refused "ALTER TABLE t ALTER COLUMN v TYPE varchar(20)" as check replayed the history and the pending files there: cannot alter type of a column ${said}`,
		)
		expect(refused).toMatch(/; check applies nothing$/)
	})

	it.each([
		["a CHECK constraint", "ALTER TABLE t ADD CONSTRAINT c CHECK (v <> '');\n"],
		["an index expression", "CREATE INDEX i ON t (lower(v));\n"],
		["a statistics object", "CREATE STATISTICS s ON v, w FROM t;\n"],
		["a view of another table's column of that name", "CREATE VIEW x AS SELECT u.v FROM t JOIN u USING (id);\n"],
	])("passes one of a column %s reads, which Postgres retypes", async (_, dependent) => {
		const { out, refused } = await checked(`${T}${dependent}`, RETYPE)
		expect(refused).toBeUndefined()
		expect(out.join("\n")).not.toContain("Check did not replay")
	})
})

describe("check of a pending retype over a history the target has applied", () => {
	it("replays the applied history before the pending file, and refuses the retype a view blocks", async () => {
		await withScratchDb((dev) =>
			withScratchDb(async (url) => {
				files(`${T}CREATE VIEW x AS SELECT v FROM t;\n`, RETYPE)
				rmSync(join(dir, "20260102000000_two.sql"))
				hashDir(run, dir)
				const out: string[] = []
				await applyWithAtlas(options({ devUrl: dev, url }, out))
				files(`${T}CREATE VIEW x AS SELECT v FROM t;\n`, RETYPE)
				await expect(applyWithAtlas({ ...options({ devUrl: dev, url }, out), checkOnly: true })).rejects.toThrow(
					/20260102000000_two\.sql: devUrl refused .* cannot alter type of a column used by a view or rule/,
				)
			}),
		)
	}, 60_000)
})

describe("check's replay of a statement only a file of its own can run", () => {
	const one =
		"CREATE TABLE ev (id int, at date) PARTITION BY RANGE (at);\nCREATE TABLE ev_2026 PARTITION OF ev FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');\n"

	it("runs a CONCURRENTLY detach in its txmode none file as written, and passes it", async () => {
		const { out, refused } = await checked(
			one,
			"-- atlas:txmode none\n\nALTER TABLE ev DETACH PARTITION ev_2026 CONCURRENTLY;\n",
		)
		expect(refused).toBeUndefined()
		expect(out.join("\n")).not.toContain("Check left")
	})

	/* P1 of r20: 0.18's replay cut the keyword to fit its one transaction, and passed what apply refuses */
	it("refuses a CONCURRENTLY detach Postgres refuses, as apply would", async () => {
		const { refused } = await checked(
			`${one}CREATE TABLE ev_def PARTITION OF ev DEFAULT;\n`,
			"-- atlas:txmode none\n\nALTER TABLE ev DETACH PARTITION ev_2026 CONCURRENTLY;\n",
		)
		expect(refused).toContain("cannot detach partitions concurrently when a default partition exists")
	})
})

/** The `i`th file's name, in order */
const nameOf = (i: number) => `20260101${String(i).padStart(6, "0")}_f${i}.sql`

/** Every file of `history` then `pending`, named in order and hashed; the history's files approved */
function writeAll(history: readonly string[], pending: string): void {
	history.forEach((sql, i) => writeFileSync(join(dir, nameOf(i)), `-- comb:allow-unsafe: the test's history\n${sql}`))
	writeFileSync(join(dir, nameOf(history.length)), pending)
	hashDir(run, dir)
}

/** A check of every file in the directory against an empty target on `devUrl`: why it refused, or undefined */
async function checkAll(dev: string): Promise<string | undefined> {
	return withScratchDb(async (url) => {
		try {
			await applyWithAtlas({ ...options({ devUrl: dev, url }, []), checkOnly: true })
			return undefined
		} catch (error) {
			return (error as Error).message
		}
	})
}

/** The `f`th file of a history of 150 tables a file */
const tablesOf = (f: number) =>
	Array.from({ length: 150 }, (_, t) => `CREATE TABLE t${f}_${t} (id bigint PRIMARY KEY, body text);`).join("\n")

/* P1 of r20: Atlas applies each file in its own transaction, so check's replay does too, in a database of its own */
describe("check replays file by file, as Atlas applies", () => {
	it("passes a history whose relations outgrow one transaction's lock table", async () => {
		writeAll(
			Array.from({ length: 40 }, (_, f) => tablesOf(f)),
			"CREATE TABLE after_all (id int PRIMARY KEY);\n",
		)
		expect(await checkAll(devUrl())).toBeUndefined()
	}, 300_000)

	it("passes a change to a table whose seed rows left deferred trigger events in an earlier file", async () => {
		writeAll(
			[
				"CREATE TABLE kind (id int PRIMARY KEY, name text);\nCREATE TABLE item (id int PRIMARY KEY, kind_id int REFERENCES kind (id) DEFERRABLE INITIALLY DEFERRED);\nINSERT INTO kind VALUES (1, 'a');\nINSERT INTO item VALUES (1, 1);\n",
			],
			"ALTER TABLE item ADD COLUMN note text;\n",
		)
		expect(await checkAll(devUrl())).toBeUndefined()
	}, 60_000)
})

/* P2 of r20: what devUrl's own database holds never changes check's verdict */
describe("check on a devUrl whose database holds objects of its own", () => {
	it("refuses a view of a function only dev holds, as apply refuses it on the target", async () => {
		const refused = await withScratchDb(async (dev) => {
			await exec(dev, "CREATE FUNCTION f() RETURNS int LANGUAGE sql AS 'SELECT 1';")
			writeAll(
				["CREATE TABLE t (id int PRIMARY KEY);\n"],
				"-- comb:allow-unsafe: the test's view\nCREATE VIEW v AS SELECT f() AS x;\n",
			)
			return checkAll(dev)
		})
		expect(refused).toMatch(/devUrl refused "CREATE VIEW v AS SELECT f\(\) AS x" .*function f\(\) does not exist/)
	}, 60_000)

	it("passes a history that makes a table dev already holds", async () => {
		const refused = await withScratchDb(async (dev) => {
			await exec(dev, "CREATE TABLE t (id int);")
			writeAll(["CREATE TABLE t (id int PRIMARY KEY);\n"], "ALTER TABLE t ADD COLUMN v text;\n")
			return checkAll(dev)
		})
		expect(refused).toBeUndefined()
	}, 60_000)
})

/* P1 of r21: what a file changes past its database, Postgres counts; the replay refuses it before COMMIT */
describe("check of a file that changes the server from inside a statement the replay cannot leave out", () => {
	const { beside, made, mgrUrl, pre } = shapeRoles(devUrl)

	/** Every role the shapes reach, as the server holds them */
	const roles = async () => [await heldRole(pre), await roleOf(made), await roleOf(beside)]

	describe.each([
		["a superuser", devUrl],
		["a CREATEDB CREATEROLE role that is not one", mgrUrl],
	])("on %s's devUrl", (_who, url) => {
		it.each(hiddenWrites(pre, made))(
			"refuses $label naming the file and the change, every role as it was",
			async ({ change, sql }) => {
				const held = await roles()
				const { refused } = await checked(T, `-- comb:allow-unsafe: the test's change\n${sql}`, url())
				expect(refused).toContain(`20260102000000_two.sql: devUrl's server counted a change past the database`)
				expect(refused).toContain(change)
				expect(await roles()).toEqual(held)
				expect(held[1]).toEqual([])
			},
			60_000,
		)

		it("passes a CREATE ROLE comb tags, and refuses a role a DO makes beside it, naming that one", async () => {
			const tagged = `-- comb:allow-unsafe: the test's role\nCREATE ROLE ${made};\nCREATE TABLE r (id int PRIMARY KEY);\nALTER TABLE r ENABLE ROW LEVEL SECURITY;\nCREATE POLICY p ON r TO ${made} USING (true);\n`
			expect((await checked(T, tagged, url())).refused).toBeUndefined()
			const { refused } = await checked(T, `${tagged}DO $$ BEGIN CREATE ROLE ${beside}; END $$;\n`, url())
			expect(refused).toContain(`role ${beside} added`)
			expect(refused).not.toContain(`role ${made} added`)
			expect([await roleOf(made), await roleOf(beside)]).toEqual([[], []])
		}, 60_000)

		/* the backend's counts carry a committed write into the next transaction's read until they flush */
		it("passes a file after the one whose CREATE ROLE comb tagged", async () => {
			const tagged = `${T}-- comb:allow-unsafe: the test's role\nCREATE ROLE ${made};\n`
			expect((await checked(tagged, RETYPE, url())).refused).toBeUndefined()
			expect(await roleOf(made)).toEqual([])
		}, 60_000)

		it("refuses a txmode none file's statement that changes the server, naming it", async () => {
			const held = await roles()
			const { refused } = await checked(
				T,
				`-- atlas:txmode none\n\n-- comb:allow-unsafe: the test's change\nCREATE TABLE x (id int);\nDO $$ BEGIN ALTER ROLE ${pre} CONNECTION LIMIT 5; END $$;\n`,
				url(),
			)
			expect(refused).toContain(
				`20260102000000_two.sql: devUrl's server counted a change past the database the replay runs in, made by "DO $$ BEGIN ALTER ROLE ${pre} CONNECTION LIMIT 5; END $$"`,
			)
			expect(refused).toContain(`role ${pre} changed (rolconnlimit)`)
			expect(await roles()).toEqual(held)
		}, 60_000)
	})
})

describe("check on a devUrl whose server keeps no counts for its role", () => {
	const [quiet, made] = [unique("comb_t_quiet"), unique("comb_t_p1a")]
	const dev = { quiet: "" }
	beforeAll(async () => {
		dev.quiet = await asRole(devUrl(), quiet, "CREATEDB")
		await query(pgUrl(), `ALTER ROLE ${quiet} SET track_counts = off`)
	})
	afterAll(() => dropRoles(quiet, made))

	it("refuses it, naming track_counts", async () => {
		const { refused } = await checked(T, RETYPE, dev.quiet)
		expect(refused).toContain("track_counts is off")
	}, 60_000)

	/* P1a of r21: a superuser's file can stop the counts for its own transaction, or for the session */
	it.each([
		["SET LOCAL", "SET LOCAL track_counts = off;\n"],
		["a session SET", "SET track_counts = off;\n"],
		["set_config inside DO", "DO $$ BEGIN PERFORM set_config('track_counts', 'off', true); END $$;\n"],
	])(
		"refuses a file that turns the counts off with %s, naming the file, the change never made",
		async (_how, off) => {
			const { refused } = await checked(
				T,
				`-- comb:allow-unsafe: the test's change\n${off}DO $$ BEGIN CREATE ROLE ${made}; END $$;\n`,
			)
			expect(refused).toContain("20260102000000_two.sql: the file turned track_counts off")
			expect(await roleOf(made)).toEqual([])
		},
		60_000,
	)
})

/* P7 of r21: the replay uses a role the server holds, as the history may have made it there, so a pending
   file's CREATE ROLE of one another database's apply made passed check, and apply stopped at it */
describe("check of a pending CREATE ROLE of a role the target's server already holds", () => {
	const role = unique("comb_t_held")
	afterEach(() => dropRoles(role))
	const make = `-- comb:allow-unsafe: the test's role\nCREATE ROLE ${role};\nCREATE TABLE r (id int PRIMARY KEY);\nGRANT SELECT ON r TO ${role};\n`

	it("refuses it, naming the file apply would stop at, once another database on the server applied it", async () => {
		await withScratchDb((other) =>
			withScratchDb(async (url) => {
				files(T, make)
				await applyWithAtlas(options({ devUrl: devUrl(), url: other }, []))
				const check = applyWithAtlas({ ...options({ devUrl: devUrl(), url }, []), checkOnly: true })
				await expect(check).rejects.toThrow(`role "${role}" already exists; apply would stop at 20260102000000_two.sql`)
				await expect(applyWithAtlas(options({ devUrl: devUrl(), url }, []))).rejects.toThrow(
					`role "${role}" already exists`,
				)
			}),
		)
	}, 60_000)

	it("passes a pending file using a role the target's own history made, which the replay reuses", async () => {
		await withScratchDb(async (url) => {
			files(make, "")
			rmSync(join(dir, "20260102000000_two.sql"))
			hashDir(run, dir)
			await applyWithAtlas(options({ devUrl: devUrl(), url }, []))
			files(make, `CREATE TABLE s (id int PRIMARY KEY);\nGRANT SELECT ON s TO ${role};\n`)
			await applyWithAtlas({ ...options({ devUrl: devUrl(), url }, []), checkOnly: true })
			expect(await roleOf(role)).not.toEqual([])
		})
	}, 60_000)
})
