import { describe, expect, it } from "vitest"
import { readCopy, rebuildsOf } from "./rebuild-copy.ts"
import { codeOf } from "./sql-code.ts"

const CREATE =
	"CREATE TABLE `new_t` (`id` text NULL, `a` text NOT NULL DEFAULT 'x, y', `b` integer NOT NULL DEFAULT (1 + 2), PRIMARY KEY (`id`))"
const create = () => CREATE

/** What may lose data in a one-column copy of `expr` into new_t's `a` */
const problem = (expr: string) => readCopy(`INSERT INTO new_t (a) SELECT ${expr} FROM t`, create)?.problem

describe("readCopy", () => {
	it("reads the tables and target columns of a copy, and finds nothing wrong with Atlas's form", () => {
		expect(
			readCopy(
				"INSERT INTO `new_t` (`id`, `a`, `b`) SELECT `id`, IFNULL(`a`, 'x, y') AS `a`, IFNULL(`b`, (1 + 2)) AS `b` FROM `t`;",
				create,
			),
		).toEqual({ columns: ["id", "a", "b"], from: "t", into: "new_t", problem: undefined })
	})

	it("reads a string holding a comma, a parenthesis or FROM as data", () => {
		const copy = readCopy("INSERT INTO `new_t` (`id`, `a`) SELECT `id`, 'a) FROM x, y' AS `a` FROM `t`", create)
		expect(copy?.problem).toBe("its copy fills a from 'a) FROM x, y' AS `a`")
	})

	it("reads no copy in a statement of another shape", () => {
		expect(readCopy("INSERT INTO t VALUES (1)", create)).toBeUndefined()
		expect(readCopy("SELECT 1", create)).toBeUndefined()
	})

	it("reads an IFNULL with more arguments, or wrapped further, as no plain copy", () => {
		expect(problem("IFNULL(a, 'x, y', 1)")).toBe("its copy fills a from IFNULL(a, 'x, y', 1)")
		expect(problem("IFNULL(a, 'x, y') || ''")).toBe("its copy fills a from IFNULL(a, 'x, y') || ''")
		expect(problem("IFNULL(a, 'x, y')")).toBeUndefined()
		expect(problem("IFNULL(a, 'x, y'")).toBe("its copy fills a from IFNULL(a, 'x, y'")
		expect(problem("IFNULL(a, 'z')")).toBe("its copy fills a from IFNULL(a, 'z')")
		expect(readCopy("INSERT INTO new_t (a) SELECT IFNULL(a, 'z') FROM t", () => "")?.problem).toBe(
			"its copy fills a from IFNULL(a, 'z')",
		)
	})
})

describe("rebuildsOf", () => {
	it("pairs a copy with the rename of its temporary table onto the table it read", () => {
		const statements = [
			CREATE,
			"INSERT INTO `new_t` (`id`) SELECT `id` FROM `t` WHERE `id` > 1",
			"DROP TABLE `t`",
			"ALTER TABLE `new_t` RENAME TO `t`",
			"ALTER TABLE `x` RENAME TO `t`",
		]
		expect(
			rebuildsOf(
				statements,
				statements.map((stmt) => codeOf(stmt, "sqlite")),
			),
		).toEqual(new Map([["t", { columns: ["id"], problem: "its copy has WHERE", temp: "new_t" }]]))
	})
})
