/// <reference types="bun-types" />
/**
 * A2-12 of r22: SQLite's NUMERIC affinity stores a text that reads as a number as an INTEGER or a
 * REAL, keeping 15 significant digits of a REAL, so a plain drizzle `numeric()` column's write DTO
 * takes only a value SQLite keeps as sent, and no spelling SQLite reads otherwise. A taken value
 * may read back in SQLite's spelling (`1.50` as `1.5`), never as another number.
 */
import { Database } from "bun:sqlite"
import { describe, expect, it } from "bun:test"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { integer, numeric, sqliteTable } from "drizzle-orm/sqlite-core"
import * as z from "zod"
import { parseField } from "../../src/codegen/__fixtures__/runtime.ts"
import { generateFieldSchema } from "../../src/codegen/generators/dtos/field-schema.ts"
import { isStorableText } from "../../src/storable-text.ts"

const row = sqliteTable("row", { id: integer("id").primaryKey(), n: numeric("n") })

/** The column's generated write DTO for `type`, evaluated */
function written(type: "create" | "update"): z.ZodType {
	const code = generateFieldSchema(parseField("n", 'numeric("n").notNull()'), type, {
		dialect: "sqlite",
		imports: { enumImports: new Map(), identifiers: new Map(), jsonSchemaImports: new Set() },
	}) as string
	/* the generated file names comb's helpers under comb's namespace */
	return new Function("z", "comb", `return ${code}`)(z, { isStorableText }) as z.ZodType
}

/** A decimal's value as its digits, leading and trailing zeros dropped, and its power of ten */
function valueOf(text: string): string {
	const [, sign, whole, fraction = "", exponent = "0"] = /^(-?)([0-9]*)(?:\.([0-9]*))?(?:e([+-]?[0-9]+))?$/i.exec(
		text,
	) as RegExpExecArray
	const digits = `${whole}${fraction}`.replace(/^0+/, "")
	const kept = digits.replace(/0+$/, "")
	if (kept === "") return "0"
	return `${sign}${kept}e${Number(exponent) - fraction.length + (digits.length - kept.length)}`
}

const POOL = [
	"1",
	"1.5",
	"00001.5",
	"1.50",
	"-0",
	"0.5",
	"123456789012345",
	"12345678901234.5",
	"0.123456789012345",
	"0.000000123",
	/* past 15 digits, which SQLite's REAL, or a driver's JS number, does not keep */
	"1234567890123456",
	"0.1234567890123456",
	"9223372036854775808",
	"1".repeat(200),
	/* spellings SQLite reads as another value, or as no number */
	"1e3",
	" 12 ",
	"+3",
	".5",
	"0x10",
	"abc",
	"",
]

describe("a SQLite numeric column's write DTO, by what SQLite stores (A2-12)", () => {
	for (const type of ["create", "update"] as const)
		it(`${type} takes only a value SQLite keeps, refusing more than 15 digits and any other spelling`, () => {
			const schema = written(type)
			const client = new Database(":memory:")
			client.run("CREATE TABLE row (id INTEGER PRIMARY KEY, n NUMERIC NOT NULL)")
			const db = drizzle({ client })
			const taken = POOL.filter((value, id) => {
				if (!schema.safeParse(value).success) return false
				db.insert(row).values({ id, n: value }).run()
				const stored = db
					.select()
					.from(row)
					.all()
					.find((each) => each.id === id)?.n as string
				expect(valueOf(stored), `${value} read back as ${stored}`).toBe(valueOf(value))
				return true
			})
			expect(taken).toEqual(POOL.slice(0, 10))
		})
})
