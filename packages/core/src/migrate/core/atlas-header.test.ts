import { describe, expect, it } from "vitest"
import { atlasHeader, linesOf, outsideTransaction, strayDirective } from "./atlas-header.ts"

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

/** The lines of `file` from `at` as linesOf read them before (fc8c3cee): a sticky regex, a null exec read as the end */
function* regexLines(file: string, at = 0): Generator<string> {
	const next = /[^\n]*\n?/y
	next.lastIndex = at
	for (let line = next.exec(file)?.[0] ?? ""; line !== ""; line = next.exec(file)?.[0] ?? "") yield line
}

/* the gate's pin (comb-9d): the indexOf reader has no arm for the null exec the regex one never met, and reads as it did */
describe("linesOf", () => {
	it.each([
		["a file that ends without a line break", "-- atlas:txmode none\nSELECT 1", 0],
		["a file that ends with one", "-- atlas:txmode none\nSELECT 1\n", 0],
		["a file of line breaks alone", "\n\n", 0],
		["a file with a carriage return before each break", "-- a\r\n\r\nSELECT 1\r\n", 0],
		["an empty file", "", 0],
		["a start offset mid-line", "-- atlas:txmode none\nSELECT 1\n", 3],
		["a start offset at a line's start", "-- atlas:txmode none\nSELECT 1\n", 21],
		["a start offset at the end", "-- atlas:txmode none\nSELECT 1\n", 30],
		["a start offset at the end of a file without a last break", "-- atlas:txmode none", 20],
	])("reads %s as the regex reader did", (_, file, at) => {
		expect([...linesOf(file, at)]).toEqual([...regexLines(file, at)])
	})

	it("reads every line with its break, the last without one where the file ends in none", () => {
		expect([...linesOf("a\r\nb\n\nc")]).toEqual(["a\r\n", "b\n", "\n", "c"])
		expect([...linesOf("a\n", 2)]).toEqual([])
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

describe("strayDirective", () => {
	it.each([
		[
			"a directive no blank line closes",
			"-- atlas:txmode none\nCREATE TABLE t (x int);\n",
			{ line: 1, text: "-- atlas:txmode none" },
		],
		["one past a comment, CRLF", "-- why\r\n#  atlas:nolint\r\nSELECT 1;\n", { line: 2, text: "#  atlas:nolint" }],
		[
			"a delimiter past the first line",
			"-- why\n-- atlas:delimiter $$\nSELECT 1$$\n",
			{ line: 2, text: "-- atlas:delimiter $$" },
		],
		[
			'a first-line delimiter Atlas\'s lexer skips, as its prefix is not "-- "',
			"--  atlas:delimiter $$\nSELECT 1$$\n",
			{ line: 1, text: "--  atlas:delimiter $$" },
		],
		[
			"the txmode after a first-line delimiter",
			"-- atlas:delimiter $$\n-- atlas:txmode none\nSELECT 1$$\n",
			{ line: 2, text: "-- atlas:txmode none" },
		],
	])("names %s", (_, file, stray) => {
		expect(strayDirective(file)).toEqual(stray)
	})

	it.each([
		["a header a blank line closes", "-- atlas:txmode none\n\nSELECT 1;\n"],
		["a file of comments alone", "-- atlas:txmode none"],
		["a first-line delimiter, which Atlas's lexer reads where it stands", "-- atlas:delimiter $$\nSELECT 1$$\n"],
		["comments with no directive", "-- why\nSELECT 1;\n"],
		["a tab after --, no directive to Atlas", "--\tatlas:txmode none\nSELECT 1;\n"],
		["no comment first", "SELECT 1;\n-- atlas:txmode none\n"],
	])("names none in %s", (_, file) => {
		expect(strayDirective(file)).toBeUndefined()
	})
})
