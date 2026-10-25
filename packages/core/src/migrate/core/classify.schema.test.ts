/**
 * M72 of the 0.13.0 round: comb scopes every Postgres URL to `search_path=<schema>`, so Postgres
 * resolves an unqualified name in the configured schema. comb keys a name the same way: under a
 * schema other than public, unqualified and `<schema>.` are one name, and `public.` another.
 */
import { describe, expect, it } from "vitest"
import { classifyMigration } from "./classify.ts"
import { extractSchema } from "./schema.ts"

const BASE = `CREATE TABLE victim (id int PRIMARY KEY);
CREATE FUNCTION wipe() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN DELETE FROM victim; RETURN NEW; END $$;`

/** `later`'s rating after `history`, both read under the configured `schema` */
function rate(history: string, later: string, schema?: string) {
	const options = schema === undefined ? {} : { schema }
	const before = extractSchema(history, undefined, { dialect: "postgres", ...options })
	return classifyMigration(later, { before, dialect: "postgres", ...options })
}

describe("a Postgres name under a configured schema (M72)", () => {
	it("fires a trigger written with the schema on a write without it", () => {
		const history = `${BASE} CREATE TABLE users (id int); CREATE TRIGGER t AFTER INSERT ON app.users FOR EACH ROW EXECUTE FUNCTION wipe();`
		expect(rate(history, "INSERT INTO users VALUES (1);", "app").safety).toBe("unsafe")
	})

	it("fires a trigger written without the schema on a write with it", () => {
		const history = `${BASE} CREATE TABLE users (id int); CREATE TRIGGER t AFTER INSERT ON users FOR EACH ROW EXECUTE FUNCTION wipe();`
		expect(rate(history, "INSERT INTO app.users VALUES (1);", "app").safety).toBe("unsafe")
	})

	it("keeps public's table apart from the schema's own of that name", () => {
		const history = "CREATE TABLE public.users (id int, n int); CREATE TABLE users (id int, email text);"
		const result = rate(history, "ALTER TABLE users ADD COLUMN n int; UPDATE public.users SET n = NULL;", "app")
		expect(result.safety).toBe("unsafe")
	})

	it("never reads an unqualified name as public's: search_path names the schema alone", () => {
		/* Postgres finds no users under app, so nothing public.users runs is reached */
		const history = `${BASE} CREATE TABLE public.users (id int); CREATE TRIGGER t AFTER INSERT ON public.users FOR EACH ROW EXECUTE FUNCTION wipe();`
		expect(extractSchema(history, undefined, { dialect: "postgres", schema: "app" }).tables.has("public.users")).toBe(
			true,
		)
		expect(extractSchema(history, undefined, { dialect: "postgres", schema: "app" }).tables.has("users")).toBe(false)
		const result = rate(history, "INSERT INTO users VALUES (1);", "app")
		expect(result.safety).not.toBe("unsafe")
		expect(JSON.stringify(result)).not.toMatch(/fires|trigger t/)
		/* the same write to public's table, named, fires its trigger */
		expect(rate(history, "INSERT INTO public.users VALUES (1);", "app").safety).toBe("unsafe")
	})

	it("reads public as one with an unqualified name when public is the schema, as before", () => {
		const history = `${BASE} CREATE TABLE users (id int); CREATE TRIGGER t AFTER INSERT ON public.users FOR EACH ROW EXECUTE FUNCTION wipe();`
		expect(rate(history, "INSERT INTO users VALUES (1);").safety).toBe("unsafe")
		expect(rate(history, "INSERT INTO users VALUES (1);", "public").safety).toBe("unsafe")
		/* an unqualified name is public's, so the schema app is another */
		expect(rate(history, "INSERT INTO app.users VALUES (1);").safety).not.toBe("unsafe")
	})
})
