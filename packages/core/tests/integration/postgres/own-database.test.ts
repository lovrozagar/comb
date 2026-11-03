/**
 * P3 of r22: a DO block that changes only the database it runs in, named by current_database() as no
 * plain statement can name it across environments, changes the replay's database, which the replay
 * drops after it: nothing outlives the check, so the change is the replay's own. apply is the oracle.
 * What the cleanup needs to drop the database, and a role the replay did not make, stay refused.
 */
import { afterEach, describe, expect, it } from "vitest"
import { pgCheck, T } from "../support/pg-check.ts"
import { dropRoles, query, unique } from "../support/pg-roles.ts"
import { pgUrl } from "../support/pg.ts"

const { checked, checkThenApply } = pgCheck()

/** A DO block that runs `statement` with `%I` as the database it runs in */
const onOwn = (statement: string) =>
	`-- comb:allow-unsafe: the test's change\nDO $$ BEGIN EXECUTE format('${statement}', current_database()); END $$;\n`

describe("a change to the replay's own database is the replay's (P3; sibling: a role the replay made)", () => {
	it.each([
		["ALTER DATABASE … SET", "ALTER DATABASE %I SET statement_timeout = ''30s''"],
		["REVOKE CONNECT … FROM PUBLIC", "REVOKE CONNECT ON DATABASE %I FROM PUBLIC"],
		["COMMENT ON DATABASE", "COMMENT ON DATABASE %I IS ''orders''"],
	])(
		"passes %s on current_database(), as apply runs it",
		async (_, statement) => {
			expect(await checkThenApply(T, onOwn(statement))).toEqual({ apply: undefined, check: undefined })
		},
		60_000,
	)
})

describe("what the replay's database needs to be dropped, and another role, stay refused (P3's constraint)", () => {
	const pre = unique("comb_t_pre")
	afterEach(() => dropRoles(pre))

	it.each([
		["IS_TEMPLATE", () => "ALTER DATABASE %I IS_TEMPLATE true", "changed (datistemplate)"],
		["OWNER TO", () => `ALTER DATABASE %I OWNER TO ${pre}`, "changed (datdba)"],
		[
			"ALTER ROLE … IN DATABASE of a role the replay did not make",
			() => `ALTER ROLE ${pre} IN DATABASE %I SET work_mem = ''8MB''`,
			`for ${pre} added`,
		],
	])(
		"refuses %s on current_database(), naming it",
		async (_, statement, said) => {
			await query(pgUrl(), `CREATE ROLE ${pre}`)
			const { refused } = await checked(T, onOwn(statement()))
			expect(refused).toContain(said)
		},
		60_000,
	)
})

/** A txmode none DO block that runs `statement` with `%I` as the database it runs in, and commits */
const committing = (statement: string) =>
	`-- atlas:txmode none\n\n-- comb:allow-unsafe: the test's change\nDO $$ BEGIN EXECUTE format('${statement}', current_database()); COMMIT; END $$;\n`

describe("a committing DO that makes the replay's database undroppable is refused bare (P3's constraint; sibling: the guarded path above)", () => {
	const pre = unique("comb_t_owner")
	afterEach(() => dropRoles(pre))

	it.each([
		["IS_TEMPLATE", () => "ALTER DATABASE %I IS_TEMPLATE true", "datistemplate"],
		["OWNER TO", () => `ALTER DATABASE %I OWNER TO ${pre}`, "datdba"],
	])(
		"refuses %s set by a DO that commits, naming the field, and leaves no replay database",
		async (_, statement, field) => {
			await query(pgUrl(), `CREATE ROLE ${pre}`)
			const { refused } = await checked(T, committing(statement()))
			expect(refused).toContain(`changed (${field})`)
			expect(refused).toContain("comb drops the database it replays in")
			const database = /database (comb_replay_\w+) changed/.exec(String(refused))?.[1]
			expect(database).toBeDefined()
			expect(await query(pgUrl(), `SELECT 1 FROM pg_database WHERE datname = '${database}'`)).toEqual([])
		},
		60_000,
	)
})
