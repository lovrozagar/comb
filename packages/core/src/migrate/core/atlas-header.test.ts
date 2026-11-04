import { describe, expect, it } from "vitest"
import { atlasHeader, outsideTransaction } from "./atlas-header.ts"

describe("atlasHeader", () => {
	it("reads the comment lines a blank line closes, with their directives, and keeps the header's text as the file has it", () => {
		const file = "-- why\r\n-- atlas:txmode none\r\n# atlas:delimiter ;;\r\n \t\r\n\nCREATE TABLE t (x int);\n"
		expect(atlasHeader(file)).toEqual({
			directives: [
				{ name: "txmode", value: "none" },
				{ name: "delimiter", value: ";;" },
			],
			text: "-- why\r\n-- atlas:txmode none\r\n# atlas:delimiter ;;\r\n \t\r\n\n",
			txmode: "none",
		})
	})

	it("reads a file of comments alone as all header, with or without a last line break", () => {
		expect(atlasHeader("-- atlas:txmode none")).toEqual({
			directives: [{ name: "txmode", value: "none" }],
			text: "-- atlas:txmode none",
			txmode: "none",
		})
		expect(atlasHeader("-- atlas:txmode file\n").text).toBe("-- atlas:txmode file\n")
	})

	it.each([
		["no comment first", "CREATE TABLE t (x int);\n-- atlas:txmode none\n\n"],
		["comments a statement follows at once", "-- atlas:txmode none\nCREATE TABLE t (x int);\n"],
		["comments a line of spaces alone ends", "-- atlas:txmode none\n  "],
		["an empty file", ""],
	])("finds no header in %s, so Atlas runs the file in one transaction", (_, file) => {
		expect(atlasHeader(file)).toEqual({ directives: [], text: "", txmode: "file" })
	})

	it("reads a directive with no value as one with an empty value, which no txmode is", () => {
		expect(atlasHeader("-- atlas:txmode\n\n")).toMatchObject({
			directives: [{ name: "txmode", value: "" }],
			txmode: { refused: 'unknown txmode "" found in file directive' },
		})
	})
})

describe("outsideTransaction", () => {
	it("is whether the header asks for txmode none", () => {
		expect([
			outsideTransaction("-- atlas:txmode none\n\nVACUUM;\n"),
			outsideTransaction("-- atlas:txmode file\n\nVACUUM;\n"),
			outsideTransaction("-- atlas:txmode NONE\n\nVACUUM;\n"),
		]).toEqual([true, false, false])
	})
})
