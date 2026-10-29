import { describe, expect, it } from "vitest"
import { explainAtlasFailure } from "./atlas-failure.ts"

/** A scrub that keeps Atlas's text as it is */
const kept = (text: string) => text

/* P3 of the 0.15.0 review: a dev database that is not empty was told as the target having no history */
describe("explainAtlasFailure on a database Atlas calls not clean", () => {
	it("names the dev database, and what it holds, when Atlas found it taking the dev snapshot", () => {
		const dev =
			'Error: sql/migrate: taking database snapshot: sql/migrate: connected database is not clean: found table "leftover" in schema "public"'
		expect(explainAtlasFailure(dev, (text) => text.replace("leftover", "<scrubbed>"))).toBe(
			'devUrl must be an empty database, and it holds table "<scrubbed>" in schema "public"; point devUrl at an empty database, or empty this one',
		)
	})

	it("keeps the target's answer for a target Atlas finds not clean", () => {
		expect(explainAtlasFailure('Error: sql/migrate: connected database is not clean: found table "t"', kept)).toMatch(
			/^the database has objects but no migration history/,
		)
	})
})

describe("explainAtlasFailure", () => {
	it("says to set devUrl when Atlas cannot reach Docker for the default dev database", () => {
		expect(explainAtlasFailure("Error: docker: Cannot connect to the Docker daemon", kept)).toBe(
			"Atlas needs Docker for the default devUrl (docker://postgres/17/dev); set devUrl to an empty Postgres database instead",
		)
		expect(explainAtlasFailure("Error: pq: relation missing", kept)).toBe("Error: pq: relation missing")
	})

	/* P15 of the 0.14.1 review: Atlas inspects the schema it is scoped to before anything runs */
	it("says to create a target schema that does not exist, once, before the first apply", () => {
		expect(explainAtlasFailure('Error: postgres: schema "app" was not found', kept)).toBe(
			"schema app does not exist on the target; create it once (CREATE SCHEMA app) before the first apply",
		)
	})

	it("says another migration is running when Atlas cannot take its lock", () => {
		expect(explainAtlasFailure("Error: acquiring database lock: sql/schema: lock is held by other session", kept)).toBe(
			"another migrate apply is running on this database; run it again once that one finishes",
		)
	})

	it("says how to drop an enum value by hand, and what to do with an object Atlas OSS refuses", () => {
		expect(explainAtlasFailure('Error: dropping value "b" from enum "mood" is not supported', kept)).toBe(
			'Atlas cannot drop the value "b" of enum "mood": write that migration by hand (a new type without it, the columns moved to it, the old type dropped), then run migrate diff again',
		)
		expect(explainAtlasFailure("Error: functions are available to logged-in users only. Use 'atlas login'", kept)).toBe(
			"Atlas OSS does not diff functions: take them out of the drizzle schema and write their migration by hand, or use Atlas Pro",
		)
	})
})
