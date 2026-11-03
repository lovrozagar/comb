/**
 * C4 of r22: a rule comb removed is gone from every text the package ships, the dated upgrade notes
 * aside, which record it as history. 0.20.0 held a password column to its hash and dropped the
 * plaintext rule (8 to 72 printable ASCII characters, bcrypt's limit), yet meta-contract §8 still
 * described the manifest that rule wrote.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"

const PACKAGE = join(import.meta.dirname, "../..")
const REPO = join(PACKAGE, "../..")

/* the plaintext password rule 0.20.0 removed from the column (C1 of r21) */
const REMOVED = ["8 to 72", "printable ASCII", "bcrypt's limit"]

/** The README without its "## Upgrading to …" sections, which the prepack copies into the package */
function readmeOutsideUpgrades(): string {
	const sections = readFileSync(join(REPO, "README.md"), "utf8").split(/\n(?=## )/)
	return sections.filter((section) => !section.startsWith("## Upgrading to ")).join("\n")
}

/** Each file under `dir` the package's `files` ships: docs, and source that is no test or fixture */
function shipped(dir: string): string[] {
	return readdirSync(join(PACKAGE, dir), { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && /\.(?:md|ts)$/.test(entry.name) && !entry.name.endsWith(".test.ts"))
		.map((entry) => relative(PACKAGE, join(entry.parentPath, entry.name)))
		.filter((path) => !path.split("/").includes("__fixtures__"))
}

/** Each line of `text` holding a removed rule, as `<where>:<line>: <rule>` */
function holding(where: string, text: string): string[] {
	return text
		.split("\n")
		.flatMap((line, at) => REMOVED.filter((rule) => line.includes(rule)).map((rule) => `${where}:${at + 1}: ${rule}`))
}

describe("a removed rule in the shipped docs (C4; siblings: the README outside its upgrade notes, and source comments)", () => {
	it("is in no doc or source file the package ships", () => {
		const files = [...shipped("docs"), ...shipped("src")]
		expect(files).toEqual(expect.arrayContaining(["docs/meta-contract.md", "src/password-text.ts"]))
		expect(files.flatMap((file) => holding(file, readFileSync(join(PACKAGE, file), "utf8")))).toEqual([])
	})

	it("is in the README only within a dated upgrade note", () => {
		expect(holding("README.md", readmeOutsideUpgrades())).toEqual([])
	})
})
