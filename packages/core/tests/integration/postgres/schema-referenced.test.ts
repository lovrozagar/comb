/**
 * QE8 of r22b: a pgSchema table is one table to a client keyed by `CombError.table`. A delete of a
 * row a child still references named it bare (`org`), where its own unique violation named the
 * qualified key (`<schema>.org`) the constraint maps give it. Run through drizzle's builder, which
 * writes the schema into the SQL, on both Node drivers.
 */
import { randomBytes } from "node:crypto"
import { eq, sql as drizzleSql } from "drizzle-orm"
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres"
import { pgSchema, text } from "drizzle-orm/pg-core"
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js"
import pg from "pg"
import postgres from "postgres"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { CombError } from "../../../src/error.ts"
import { pgErrorHandler } from "../../../src/pg/error-handler.ts"
import type { ConstraintMap } from "../../../src/types.ts"
import { pgUrl } from "../support/pg.ts"

const SCHEMA = `qe8_${randomBytes(4).toString("hex")}`
const app = pgSchema(SCHEMA)
const org = app.table("org", { id: text("id").primaryKey(), name: text("name").unique() })

const MAPS: ConstraintMap[] = [{ [`${SCHEMA}.member`]: {}, [`${SCHEMA}.org`]: {} }]

/** What pgErrorHandler throws for the error `run` raises */
async function handled(run: () => Promise<unknown>): Promise<CombError | undefined> {
	const failure = await run().then(
		() => new Error("the statement did not fail"),
		(error: unknown) => error,
	)
	try {
		pgErrorHandler(failure, MAPS)
	} catch (thrown) {
		return thrown as CombError
	}
	return undefined
}

describe("pgErrorHandler on a real server: a pgSchema table a child references (QE8 of r22b)", () => {
	const client = new pg.Client({ connectionString: pgUrl() })
	const sql = postgres(pgUrl(), { max: 1, onnotice: () => undefined })
	const viaPg = drizzlePg({ client })
	const viaPostgres = drizzlePostgres({ client: sql })
	/* the same two statements on each driver: a duplicate name, and a delete of the referenced org */
	const drivers = {
		"node-postgres via drizzle": {
			referenced: () => viaPg.delete(org).where(eq(org.id, "o1")),
			unique: () => viaPg.insert(org).values({ id: "o2", name: "Acme" }),
		},
		"postgres.js via drizzle": {
			referenced: () => viaPostgres.delete(org).where(eq(org.id, "o1")),
			unique: () => viaPostgres.insert(org).values({ id: "o2", name: "Acme" }),
		},
	}

	beforeAll(async () => {
		await client.connect()
		await client.query(`
			CREATE SCHEMA "${SCHEMA}";
			CREATE TABLE "${SCHEMA}".org (id text PRIMARY KEY, name text UNIQUE);
			CREATE TABLE "${SCHEMA}".member (id text PRIMARY KEY, org_id text REFERENCES "${SCHEMA}".org(id));
			INSERT INTO "${SCHEMA}".org VALUES ('o1', 'Acme');
			INSERT INTO "${SCHEMA}".member VALUES ('m1', 'o1');
		`)
	})
	afterAll(async () => {
		await client.query(`DROP SCHEMA "${SCHEMA}" CASCADE`)
		await Promise.all([client.end(), sql.end()])
	})

	for (const [driver, run] of Object.entries(drivers)) {
		it(`${driver}: names the table by one key in its unique violation and its referenced delete`, async () => {
			const unique = await handled(run.unique)
			const referenced = await handled(run.referenced)
			expect(unique).toMatchObject({ errorKey: "unique_constraint_violation", table: `${SCHEMA}.org` })
			expect(referenced).toMatchObject({ errorKey: "foreign_key_violation", table: `${SCHEMA}.org` })
		})
	}

	/* AB7 of area B: raw SQL run through drizzle, which records it, may write ONLY, which named the table "ONLY" */
	it("names the table by its key in a referenced DELETE FROM ONLY and UPDATE ONLY, on both drivers", async () => {
		for (const db of [viaPg, viaPostgres])
			for (const statement of [
				`DELETE FROM ONLY "${SCHEMA}"."org" WHERE id = 'o1'`,
				`UPDATE ONLY "${SCHEMA}"."org" SET id = 'o9' WHERE id = 'o1'`,
			])
				expect(await handled(() => db.execute(drizzleSql.raw(statement))), statement).toMatchObject({
					errorKey: "foreign_key_violation",
					table: `${SCHEMA}.org`,
				})
	})
})
