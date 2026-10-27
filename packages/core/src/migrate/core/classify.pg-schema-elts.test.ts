/**
 * M74 of the 0.13.0 round, its CREATE SCHEMA case: Postgres creates each element of
 * `CREATE SCHEMA s …` in s, and resolves an unqualified name in an element to s only when an
 * element of the same statement makes it; any other name resolves as it would outside it
 * (probed on Postgres 17: .tmp/grunt/r15/m74-probe-schema-elts.out.txt).
 */
import { describe, expect, it } from "vitest"
import { classifyMigration } from "./classify.ts"
import { extractSchema } from "./schema.ts"

const BASE = `CREATE TABLE victim (id int PRIMARY KEY);
CREATE FUNCTION wipe() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN DELETE FROM victim; RETURN NEW; END $$;`
const ELEMENTS =
	"CREATE SCHEMA s CREATE TABLE t (id int) CREATE TRIGGER tr AFTER INSERT ON t FOR EACH ROW EXECUTE FUNCTION wipe();"

/** `later`'s rating and notes after `history`, read as Postgres */
function rate(history: string, later: string) {
	const before = extractSchema(history, undefined, "postgres")
	const result = classifyMigration(later, { before, dialect: "postgres" })
	return { notes: result.unsafeStatements.join(" "), safety: result.safety }
}

describe("names inside CREATE SCHEMA elements (M74)", () => {
	it("keys an element's table in the new schema, so its trigger fires on a write there, in the history or the file", () => {
		expect(rate(`${BASE}\n${ELEMENTS}`, "INSERT INTO s.t VALUES (1);").notes).toContain("fires trigger tr")
		expect(rate(BASE, `${ELEMENTS}\nINSERT INTO s.t VALUES (1);`).notes).toContain("fires trigger tr")
	})

	it("resolves a name no element makes as it would outside the statement: a view in s over public's users", () => {
		const history = `${BASE}\nCREATE TABLE users (id int);\nCREATE TRIGGER u AFTER INSERT ON users FOR EACH ROW EXECUTE FUNCTION wipe();\nCREATE SCHEMA s CREATE VIEW v AS SELECT id FROM users;`
		expect(rate(history, "INSERT INTO s.v VALUES (1);").notes).toContain("fires trigger u")
	})

	it("takes public's own t for neither s.t nor its trigger", () => {
		expect(rate(`${BASE}\nCREATE TABLE t (id int);\n${ELEMENTS}`, "INSERT INTO t VALUES (1);").safety).toBe("safe")
	})
})
