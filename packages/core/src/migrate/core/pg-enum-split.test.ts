import { describe, expect, it } from "vitest"
import { splitEnumValues } from "./pg-enum-split.ts"

const ATLAS = `-- Add value to enum type: "status"
ALTER TYPE "status" ADD VALUE 'archived';
-- Modify "post" table
ALTER TABLE "post" ADD COLUMN "prev" "status" NOT NULL DEFAULT 'archived';
`

describe("splitEnumValues", () => {
	it("moves each ADD VALUE into a file of its own one version earlier, so the rest can use the value", () => {
		expect(splitEnumValues("20261018000000_add.sql", ATLAS)).toEqual([
			[
				"20261018000000_add_enum_values.sql",
				`-- Add value to enum type: "status"\nALTER TYPE "status" ADD VALUE 'archived';\n`,
			],
			[
				"20261018000001_add.sql",
				`-- Modify "post" table\nALTER TABLE "post" ADD COLUMN "prev" "status" NOT NULL DEFAULT 'archived';\n`,
			],
		])
	})

	it("keeps the directives on the file that runs Atlas's other statements", () => {
		const [values, rest] = splitEnumValues("20261231235959_x.sql", `-- atlas:txmode none\n\n${ATLAS}`)
		expect(values?.[1].startsWith("-- atlas")).toBe(false)
		expect(rest?.[0]).toBe("20270101000000_x.sql")
		expect(rest?.[1].startsWith("-- atlas:txmode none\n\n-- Modify")).toBe(true)
	})

	it("leaves a file alone that only adds values, or adds none", () => {
		const only = `ALTER TYPE "status" ADD VALUE 'archived';\n`
		expect(splitEnumValues("20261018000000_add.sql", only)).toEqual([["20261018000000_add.sql", only]])
		const none = 'ALTER TABLE "post" ADD COLUMN "x" text;\n'
		expect(splitEnumValues("20261018000000_add.sql", none)).toEqual([["20261018000000_add.sql", none]])
	})

	it("leaves a file whose name carries no version alone", () => {
		expect(splitEnumValues("manual.sql", ATLAS)).toEqual([["manual.sql", ATLAS]])
	})
})
