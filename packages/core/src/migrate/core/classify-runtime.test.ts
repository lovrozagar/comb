import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import { runtimeFindings } from "./classify-runtime.ts"

describe("runtimeFindings", () => {
	/* R4: every other pragma is unsafe by default-deny's rule alone, never also cautious here */
	/* S1 of r19: the name is read unquoted, as SQLite reads it */
	it.each(['PRAGMA "foreign_keys" = off', "PRAGMA [Foreign_Keys] = 0", "PRAGMA main.`foreign_keys` = false"])(
		"rates %j as foreign_keys, cautious, quoted or not",
		(sql) => {
			expect(runtimeFindings(sql).map((finding) => finding.level)).toEqual(["cautious"])
		},
	)

	/* S4 of r19: on is the state comb's transaction keeps anyway, and a read changes nothing, so neither carries the note */
	it.each(["PRAGMA foreign_keys = on", "PRAGMA foreign_keys(1)", "PRAGMA foreign_keys"])(
		"gives %j no finding of its own",
		(sql) => {
			expect(runtimeFindings(sql)).toEqual([])
		},
	)

	it("rates a quoted writable_schema unsafe", () => {
		expect(runtimeFindings('PRAGMA "writable_schema" = 1').map((finding) => finding.level)).toEqual(["unsafe"])
	})

	it("rates a pragma by name: comb's own nothing, foreign_keys cautious, writable_schema unsafe, any other nothing", () => {
		expect(runtimeFindings("PRAGMA main.defer_foreign_keys = on")).toEqual([])
		expect(runtimeFindings("PRAGMA foreign_keys = off")).toEqual([
			{
				level: "cautious",
				note: "does nothing inside the transaction comb runs each file in: foreign keys stay on, and comb migrate diff writes defer_foreign_keys instead",
			},
		])
		expect(runtimeFindings("PRAGMA WRITABLE_SCHEMA = 1")[0]?.level).toBe("unsafe")
		expect(runtimeFindings("PRAGMA recursive_triggers = on")).toEqual([])
		expect(runtimeFindings("PRAGMA journal_mode = WAL")).toEqual([])
	})
})

const rated = (code: string) => runtimeFindings(code)
const levels = (code: string) => rated(code).map((finding) => finding.level)

/* SQLite reads a value it does not know as off, and SQLite versions read numbers apart, so no value SQLite reads
   off may pass without the note: node:sqlite is the oracle */
const VALUES = [
	"on",
	"ON",
	"yes",
	"TRUE",
	"'on'",
	"'True'",
	'"on"',
	"[on]",
	"`yes`",
	"1",
	"2",
	"01",
	"10",
	"+1",
	"+ 1",
	"1.5",
	"1e3",
	"'1x'",
	"'2'",
	"255",
	"257",
	"2147483647",
	"0xff",
	"0X00ff",
	"0x7fffffff",
	"off",
	"no",
	"nO",
	"false",
	"0",
	"00",
	"'0'",
	"+0",
	"-0",
	"-1",
	"'-1'",
	"'+1'",
	"' 1'",
	"''",
	"'+'",
	"nope",
	"'nope'",
	'"nope"',
	"full",
	"extra",
	"none",
	"'x1'",
	"0.5",
	"'0.5'",
	"0x0",
	"'0x'",
	"'0xg'",
	"'0x1'",
	"0x80000000",
	"0x100000000",
	"0x0000000001",
	"2147483648",
	"4294967297",
	"99999999999",
	"00000000000001",
	"000000000001",
]

describe("runtimeFindings on foreign_keys's value (S2 of r20)", () => {
	it.each(VALUES)("gives foreign_keys = %s the note wherever SQLite reads it off", (value) => {
		const db = new DatabaseSync(":memory:")
		db.exec(`PRAGMA foreign_keys = 0; PRAGMA foreign_keys = ${value}`)
		const off = (db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys === 0
		db.close()
		for (const sql of [`PRAGMA foreign_keys = ${value}`, `PRAGMA foreign_keys(${value})`]) {
			expect(off ? levels(sql) : ["cautious"], sql).toEqual(["cautious"])
		}
	})

	/* on, yes, true and 1, in any case, quoted or not, and 1 behind a unary plus, which SQLite's grammar drops */
	it.each([
		"on",
		"ON",
		"'on'",
		'"on"',
		"[on]",
		"yes",
		"`Yes`",
		"'yes'",
		"true",
		"TRUE",
		"'True'",
		"1",
		"'1'",
		"+1",
		"+ 1",
	])("gives foreign_keys = %s, which comb writes as on, no note", (value) => {
		expect(levels(`PRAGMA foreign_keys = ${value}`)).toEqual([])
		expect(levels(`PRAGMA foreign_keys(${value})`)).toEqual([])
	})

	/* any other value is noted however SQLite reads it: 256 is off on 3.53 (bun:sqlite) and on on 3.54 (node:sqlite) */
	it.each(["2", "+2", "01", "10", "0x1", "1.5", "'2'", "256", "'256'", "0x100", "'nope'", "full", "off", "0"])(
		"gives foreign_keys = %s the note",
		(value) => {
			expect(levels(`PRAGMA foreign_keys = ${value}`)).toEqual(["cautious"])
		},
	)
})

describe("runtimeFindings on a trigger (M1)", () => {
	it("reads a SQLite trigger's body as writes that run on every later write to its table", () => {
		expect(rated("CREATE TRIGGER wipe AFTER INSERT ON Users BEGIN DELETE FROM users; END")).toEqual([
			{ level: "unsafe", note: "runs on every later write to Users" },
		])
		expect(
			rated("CREATE TRIGGER nul AFTER INSERT ON users BEGIN SELECT 1; UPDATE users SET email = NULL; END"),
		).toEqual([{ level: "unsafe", note: "runs on every later write to users" }])
	})

	it("passes a trigger whose body only inserts or selects, and one that executes a function to its own rule", () => {
		expect(
			rated("CREATE TRIGGER t_ai AFTER INSERT ON t BEGIN INSERT INTO fts(rowid, x) VALUES (new.id, new.x); END"),
		).toEqual([])
		expect(rated("CREATE TRIGGER t AFTER INSERT ON t FOR EACH ROW EXECUTE FUNCTION f()")).toEqual([])
	})

	it("rates a trigger whose body comb cannot read cautious", () => {
		expect(rated("CREATE TRIGGER t AFTER INSERT ON t FOR EACH ROW WHEN (1)")).toEqual([
			{ level: "cautious", note: "a trigger whose body comb cannot read" },
		])
	})
})

describe("runtimeFindings on a rule (M9)", () => {
	it("rates a rule that does INSTEAD NOTHING on a write unsafe, and any other INSTEAD rule cautious", () => {
		expect(rated("CREATE RULE r AS ON INSERT TO users DO INSTEAD NOTHING")).toEqual([
			{ level: "unsafe", note: "silently discards every INSERT on users" },
		])
		expect(
			rated("CREATE OR REPLACE RULE r AS ON DELETE TO public.users WHERE old.id > 0 DO INSTEAD NOTHING")[0]?.level,
		).toBe("unsafe")
		expect(rated("CREATE RULE r AS ON UPDATE TO users DO INSTEAD SELECT 1")).toEqual([
			{ level: "cautious", note: "replaces every UPDATE on users" },
		])
		expect(rated("CREATE RULE r AS ON SELECT TO v DO INSTEAD NOTHING")[0]?.level).toBe("cautious")
		expect(rated("CREATE RULE r AS ON INSERT TO users DO ALSO NOTHING")).toEqual([])
	})
})
