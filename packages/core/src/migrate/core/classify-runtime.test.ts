import { describe, expect, it } from "vitest"
import { preparedOf, runtimeFindings } from "./classify-runtime.ts"

const none = () => []

describe("preparedOf", () => {
	it("reads each prepared statement's name and the code it runs", () => {
		expect([...preparedOf(['PREPARE "s" (int) AS DELETE FROM t WHERE id = $1', "SELECT 1"])]).toEqual([
			["s", "DELETE FROM t WHERE id = $1"],
		])
	})
})

describe("runtimeFindings", () => {
	it("reads an EXECUTE as what it runs, and one comb cannot read as cautious", () => {
		const prepared = new Map([["s", "DELETE FROM t"]])
		expect(runtimeFindings("EXECUTE s", prepared, () => [{ level: "unsafe" }])).toEqual([{ level: "unsafe" }])
		expect(runtimeFindings("EXECUTE other", prepared, none)).toEqual([
			{ level: "cautious", note: "runs a prepared statement comb cannot read" },
		])
	})

	it("rates a pragma by name: comb's own nothing, writable_schema unsafe, any other cautious", () => {
		expect(runtimeFindings("PRAGMA main.defer_foreign_keys = on", new Map(), none)).toEqual([])
		expect(runtimeFindings("PRAGMA WRITABLE_SCHEMA = 1", new Map(), none)[0]?.level).toBe("unsafe")
		expect(runtimeFindings("PRAGMA recursive_triggers = on", new Map(), none)[0]?.level).toBe("cautious")
	})
})

const rated = (code: string) => runtimeFindings(code, new Map(), none)

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
