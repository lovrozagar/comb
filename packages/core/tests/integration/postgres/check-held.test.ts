/**
 * Check's held warnings measured (0005 and PA8 of r22b, after PR5): a VALIDATE scans every row under
 * each lock its file took before it, and what a DO block, a function or EXECUTE locks no rating of
 * the file's text can see. On a postgres:// devUrl check replays the file as Atlas applies it, reads
 * what its transaction holds from pg_locks before each VALIDATE, and warns of that, so the warning
 * is Postgres's: each lock oracle case reads as lock-oracle-held.test.ts holds it, a lock a DO block
 * takes is named, and a table a DO block made, which no other session sees, is not. apply, and check
 * where it replays nothing, warn from pg-held.ts's map of the file's text, so each case also holds
 * that map to hold all the replay measures, but for what UNSEEN names, which no reading of the text sees.
 */
import { describe, expect, it } from "vitest"
import { applyWithAtlas } from "../../../src/migrate/core/atlas-apply.ts"
import { classifyMigration } from "../../../src/migrate/core/classify.ts"
import { replayPending } from "../../../src/migrate/core/pg-check-replay.ts"
import { extractSchema } from "../../../src/migrate/core/schema.ts"
import { CASES, HISTORY, OWNING, owning, VALIDATE } from "../support/held-cases.ts"
import { pgCheck, T } from "../support/pg-check.ts"
import { warningOf } from "../support/pg-locks.ts"
import { pgUrl } from "../support/pg.ts"
import { query, testRoles } from "../support/pg-roles.ts"

const { checked, devUrl, files, options, targetUrl } = pgCheck()

/* the pending file's own approval, so a case's unsafe statement passes and its warnings print */
const ALLOW = "-- comb:allow-unsafe: the test's pending file\n"
const WARNING = "Lock warning in 20260102000000_two.sql: "

/* what the replay says of a sequence it names: the tables whose default calls it, which the map does not read */
const CALLS = / \([^()]+ calls? it\)/g

/** The warnings `out` prints of `validate`, the pending file's VALIDATE, as they name each relation */
const heldOf = (out: readonly string[], validate: string, said: "as said" | "bare" = "bare"): string[] =>
	out
		.filter((line) => line.startsWith(`${WARNING}${validate.slice(0, -1)} (`))
		.map((line) => line.slice(WARNING.length))
		.map((line) => (said === "bare" ? line.replaceAll(CALLS, "") : line))

/*
 * what the map says it locks that it cannot name, after what it names: the objects a DROP … CASCADE
 * dropped, and the rest the replay measures, a dropped table's sequences, a type's tables; then
 * what a DROP or REASSIGN OWNED's roles own, which the replay leaves out
 */
const OWNERS = /(?:^|, and )this file (?:also )?locks (everything .*), which comb cannot name$/
const UNNAMED =
	/(?:^|, and )(?:this file's DROP … CASCADE locks what depends on (.*?)(?:, and this file also locks (.*))?|this file locks (.*)), which only check on a postgres:\/\/ devUrl names$/

/** What the file holds: each relation named, with what it blocks, and what it locks that it cannot name */
type Said = { cascades: string[]; held: Record<string, string>; others: string[]; owners: string[] }

/** The items of a list as listed writes them */
const items = (list: string | undefined): string[] => (list === undefined ? [] : list.split(/, | and /))

/** What a warning says its file locks that it cannot name, and what it says before that */
function unnamedIn(all: string): Omit<Said, "held"> & { holding: string } {
	const owned = OWNERS.exec(all)
	const said = owned === null ? all : all.slice(0, owned.index)
	const unnamed = UNNAMED.exec(said)
	return {
		cascades: items(unnamed?.[1]),
		holding: (unnamed === null ? said : said.slice(0, unnamed.index)).replace(/^this file holds /, ""),
		others: items(unnamed?.[2] ?? unnamed?.[3]),
		owners: items(owned?.[1]),
	}
}

/** What a warning of `validate`, a VALIDATE on `table`, says its file holds, read so warningOf writes it back */
function heldIn(lines: readonly string[], { table, validate }: { table: string; validate: string }): Said {
	const held: Record<string, string> = {}
	const { cascades, holding, others, owners } = unnamedIn(
		/scans \S+ while (.*); those locks/.exec(lines[0] ?? "")?.[1] ?? "",
	)
	if (holding.startsWith("it locked against ")) held[table] = holding.slice("it locked against ".length)
	else
		for (const part of holding === "" ? [] : holding.split(", and ")) {
			const [, names, blocks] = /^(.*?)(?: locked)? against (reads and writes|writes)$/.exec(part) ?? []
			for (const name of String(names).split(/, | and /)) held[name] = String(blocks)
		}
	expect(warningOf({ table, validate }, held, { cascades, others, owners })).toEqual(lines)
	return { cascades, held, others, owners }
}

/** What pg-held.ts's map of `two` after `one` holds at `validate`, a VALIDATE on `table`, as apply warns of it */
function mapped(one: string, two: string, at: { table: string; validate: string }): Said {
	const { lockWarnings } = classifyMigration(two, {
		before: extractSchema(one, undefined, "postgres"),
		dialect: "postgres",
	})
	return heldIn(
		lockWarnings.filter((line) => line.startsWith(`${at.validate.slice(0, -1)} (`)),
		at,
	)
}

/**
 * Whether `map` holds each relation `measured` does, as strongly: reads and writes, or writes at
 * least; what it says it locks that it cannot name covers any relation the replay measures
 */
const holdsAll = ({ cascades, held, others, owners }: Said, measured: Readonly<Record<string, string>>): boolean =>
	cascades.length > 0 ||
	others.length > 0 ||
	owners.length > 0 ||
	Object.entries(measured).every(([name, blocks]) => held[name] === blocks || held[name] === "reads and writes")

// lookup-table: what the replay measures and pg-held.ts's map cannot, by why; apply warns without it, so run check first
const UNSEEN = {
	dynamic:
		"a lock a DO block, a function or EXECUTE takes: the map reads the file's text, and their SQL is a string run later",
	renamed: "a table a DO block renamed: the map goes by the name the text gives it, which the DO body changed",
} as const

/**
 * That pg-held.ts's map of `two` after `one` holds all the replay printed in `out` at `at`'s VALIDATE,
 * or, for a case UNSEEN names by `unseen`, that it misses some of it
 */
function mapHolds(
	{ one, out, two }: { one: string; out: readonly string[]; two: string },
	at: { table: string; validate: string },
	unseen?: keyof typeof UNSEEN,
): void {
	expect(holdsAll(mapped(one, two, at), heldIn(heldOf(out, at.validate), at).held), unseen && UNSEEN[unseen]).toBe(
		unseen === undefined,
	)
}

/** What check prints of `one` then `two` when it replays nothing, as without the postgres package */
async function unreplayed(one: string, two: string): Promise<string[]> {
	await files(one, two)
	const out: string[] = []
	await applyWithAtlas({
		...options({ devUrl: devUrl(), url: targetUrl() }, out),
		checkOnly: true,
		replayPending: (at, pending) => replayPending(at, pending, () => Promise.reject(new Error("no postgres"))),
	})
	return out
}

/* a history leaving t's CHECK c to validate, and the pending file's VALIDATE of it */
const NOT_VALID = `${T}ALTER TABLE t ADD CONSTRAINT c CHECK (w > 0) NOT VALID;\n`
const VALIDATE_T = "ALTER TABLE t VALIDATE CONSTRAINT c;"
const AT_T = { table: "t", validate: VALIDATE_T }

describe("check's held warnings, measured on devUrl", () => {
	it.each(CASES)(
		"after %s, warns of what Postgres holds at the VALIDATE",
		async (first, held) => {
			const two = `${ALLOW}${first}\n${VALIDATE}\n`
			const { out, refused } = await checked(HISTORY, two)
			expect(refused).toBeUndefined()
			expect(heldOf(out, VALIDATE)).toEqual(warningOf({ table: "users", validate: VALIDATE }, held))
			mapHolds({ one: HISTORY, out, two }, { table: "users", validate: VALIDATE })
		},
		60_000,
	)

	it("names what a DO block locks, which only the replay sees", async () => {
		const two = `${ALLOW}DO $$BEGIN EXECUTE 'ALTER TABLE u ADD COLUMN x int'; END$$;\n${VALIDATE_T}\n`
		expect(heldOf(await unreplayed(NOT_VALID, two), VALIDATE_T)).toEqual([])
		const { out, refused } = await checked(NOT_VALID, two)
		expect(refused).toBeUndefined()
		expect(heldOf(out, VALIDATE_T)).toEqual(warningOf({ table: "t", validate: VALIDATE_T }, { u: "reads and writes" }))
		mapHolds({ one: NOT_VALID, out, two }, AT_T, "dynamic")
	})

	it("names a table a DO block renamed by the name it has at the VALIDATE", async () => {
		const two = `${ALLOW}DO $$BEGIN EXECUTE 'ALTER TABLE u RENAME TO u2'; END$$;\n${VALIDATE_T}\n`
		expect(heldOf(await unreplayed(NOT_VALID, two), VALIDATE_T)).toEqual([])
		const { out, refused } = await checked(NOT_VALID, two)
		expect(refused).toBeUndefined()
		expect(heldOf(out, VALIDATE_T)).toEqual(warningOf({ table: "t", validate: VALIDATE_T }, { u2: "reads and writes" }))
		mapHolds({ one: NOT_VALID, out, two }, AT_T, "renamed")
	})

	it("leaves out a table a DO block made, which no other session sees", async () => {
		const two = `${ALLOW}DO $$BEGIN EXECUTE 'CREATE TABLE z (id int)'; END$$;\nALTER TABLE z ADD COLUMN y int;\n${VALIDATE_T}\n`
		expect(heldOf(await unreplayed(NOT_VALID, two), VALIDATE_T)).toEqual(
			warningOf({ table: "t", validate: VALIDATE_T }, { z: "reads and writes" }),
		)
		const { out, refused } = await checked(NOT_VALID, two)
		expect(refused).toBeUndefined()
		expect(heldOf(out, VALIDATE_T)).toEqual([])
		/* the map names z, which Postgres does not: more than the replay measures, never less */
		mapHolds({ one: NOT_VALID, out, two }, AT_T)
	})
})

describe("check's held warnings of a lock no CASE takes, measured on devUrl (Area E round 2)", () => {
	it("holds a table a LOCK IN EXCLUSIVE MODE took against writes", async () => {
		const one = `${NOT_VALID}CREATE TABLE ex (id int);\n`
		const two = `${ALLOW}LOCK ex IN EXCLUSIVE MODE;\n${VALIDATE_T}\n`
		const { out, refused } = await checked(one, two)
		expect(refused).toBeUndefined()
		expect(heldOf(out, VALIDATE_T)).toEqual(warningOf(AT_T, { ex: "writes" }))
		mapHolds({ one, out, two }, AT_T)
	})

	it("holds a table a REINDEX locked through its TOAST table alone against reads and writes", async () => {
		const one = `${NOT_VALID}CREATE TABLE tx (v text);\n`
		const two = `${ALLOW}REINDEX TABLE tx;\n${VALIDATE_T}\n`
		const { out, refused } = await checked(one, two)
		expect(refused).toBeUndefined()
		expect(heldOf(out, VALIDATE_T)).toEqual(warningOf(AT_T, { tx: "reads and writes" }))
		mapHolds({ one, out, two }, AT_T)
	})

	/* AE2-3 of r22: a sequence is the relation Postgres locks, and the replay says which tables call it */
	it("names a sequence the file locks, with each table another session sees whose default or identity calls it", async () => {
		const one = `${NOT_VALID}CREATE SEQUENCE sq;\nCREATE TABLE a (id bigint DEFAULT nextval('sq'));\nCREATE TABLE b (id serial, n bigint DEFAULT nextval('sq'));\nCREATE SEQUENCE lone;\nCREATE TABLE g (id int GENERATED ALWAYS AS IDENTITY);\n`
		const two = `${ALLOW}CREATE TABLE fresh (id bigint DEFAULT nextval('sq'));\nALTER SEQUENCE sq RESTART;\nALTER SEQUENCE lone RESTART;\nALTER SEQUENCE g_id_seq RESTART;\n${VALIDATE_T}\n`
		const { out, refused } = await checked(one, two)
		expect(refused).toBeUndefined()
		expect(heldOf(out, VALIDATE_T, "as said")).toEqual([
			`${VALIDATE_T.slice(0, -1)} (scans t while this file holds g_id_seq (g's identity calls it), lone and sq (the defaults of a and b call it) locked against writes; those locks last to the file's COMMIT; validate in a later file)`,
		])
		mapHolds({ one, out, two }, AT_T)
	})

	it.each(OWNING)(
		"after %s on a role, warns of what the role owns, which the replay leaves out and comb cannot name",
		async (statement) => {
			const [role] = testRoles("comb_t_own")
			await query(pgUrl(), `CREATE ROLE ${role}`)
			const one = `${NOT_VALID}${owning(role).history}\n`
			const two = `${ALLOW}${statement(role)}\n${VALIDATE_T}\n`
			const { out, refused } = await checked(one, two)
			expect(refused).toBeUndefined()
			/* the replay leaves the statement out, as it reaches past its database, so the map's clause stands */
			const left = `Check left ${JSON.stringify(statement(role).slice(0, -1))} in 20260102000000_two.sql out of its replay`
			expect(out.filter((line) => line.startsWith(left))).toHaveLength(1)
			expect(heldOf(out, VALIDATE_T)).toEqual(warningOf(AT_T, {}, owning(role).mapped))
			mapHolds({ one, out, two }, AT_T)
		},
		60_000,
	)

	it("leaves out a temp table the file made in an earlier transaction, which no other session sees", async () => {
		const two = `-- atlas:txmode none\n\n${ALLOW}CREATE TEMP TABLE tt (id int);\nBEGIN;\nLOCK tt IN ACCESS EXCLUSIVE MODE;\n${VALIDATE_T}\nCOMMIT;\n`
		const { out, refused } = await checked(NOT_VALID, two)
		expect(refused).toBeUndefined()
		expect(heldOf(out, VALIDATE_T)).toEqual([])
	})
})
