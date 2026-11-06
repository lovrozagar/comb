/**
 * The README's Postgres migrate paragraphs say what comb does (nits of r22b, plan 21 leaf 10.8):
 * the outside-transaction list names every statement check refuses in a file Atlas runs in one
 * transaction (PA14, pg-outside-transaction.ts), with a 0.21 upgrade note for the partitioned ones
 * 0.20 added; and `status` refuses an applied file edited since, as checkHistory does (PA21,
 * atlas-history.ts), where the README said it warned. The 0.21 notes, read up to the next section,
 * hold an item for each change 0.21 made to check's Postgres ratings and refusals, and 0.18's hold
 * none of them (AE2-7, AE2-10). Sibling: the session paragraph
 * (readme-pg-session.test.ts).
 */
import { describe, expect, it } from "vitest"
import { README, section } from "./support/readme.ts"

const [docs = ""] = README.split("\n## Upgrading to 0.21\n")
const upgrade = section("Upgrading to 0.21")

/** The README paragraph, outside the upgrade notes, that holds `marker` */
function paragraph(marker: string): string {
	return docs.split("\n\n").find((text) => text.includes(marker)) ?? ""
}

/** The sentence of `text` that holds `marker` */
function sentence(text: string, marker: string): string {
	return text.split(/(?<=\.) (?=[`A-Z])/).find((part) => part.includes(marker)) ?? ""
}

describe("the 0.21 upgrade notes these tests read (AE2-10)", () => {
	it("end where the 0.20.1 notes start", () => {
		expect(upgrade).not.toContain("\n## Upgrading to 0.20")
		expect(upgrade).toContain("Run comb on Node 22.13 or later")
	})
})

describe("the 0.21 upgrade notes on Postgres check's ratings and refusals (AE2-7)", () => {
	/* each 0.21 change a 0.20 project meets, by its item's title */
	it.each([
		"Expect check to rate a retype by what Postgres 17 does in place, on Postgres.",
		"Expect no lock warning for a move to where the history left a relation, on Postgres.",
		"Expect no scan warning for an `ATTACH PARTITION` whose bound the history proves, on Postgres.",
		"Expect a `COPY` and an `EXECUTE` to be rated by what they do, on Postgres.",
		"Keep `atlas.sum` with CRLF line ends.",
		"Expect check to refuse a role setting a `DO` block commits for devUrl's role or for every role, on Postgres.",
	])("holds the item %s, with its fix", (title) => {
		const item = upgrade.split("\n").find((line) => /^\d+\. \*\*/.test(line) && line.includes(`**${title}**`))
		expect(item).toContain("**Fix:**")
	})

	it("leaves 0.18's notes as 0.18 shipped them", () => {
		const notes = section("Upgrading to 0.18")
		expect(notes).toContain("ATTACH PARTITION … DEFAULT's warning says")
		expect(notes).not.toContain("An ATTACH PARTITION that follows the recipe no longer warns")
		expect(notes).not.toContain("where 0.20 rated every one unsafe")
	})
})

describe("the README on the role names a file's shared-catalog change is read by (AE2-11)", () => {
	it("says CURRENT_USER and its kin name devUrl's role, and ALTER ROLE ALL every role", () => {
		const guard = paragraph("a change there is the file's only when the role, database or other object")
		expect(sentence(guard, "name devUrl's role")).toContain(
			"`CURRENT_USER`, `CURRENT_ROLE`, `SESSION_USER` and `USER` name devUrl's role, and `ALL` in `ALTER ROLE ALL` names every role",
		)
	})
})

describe("the README's Postgres lock warnings (AE2-12)", () => {
	const warnings = sentence(
		paragraph("`apply` works on a private copy of the migrations directory"),
		"with lock warnings for statements that block a table",
	)

	it("says an ATTACH PARTITION whose bound the history proves scans only the default partition", () => {
		expect(warnings).toContain("an `ATTACH PARTITION`, which scans the partition unless the history proves its bound")
		expect(warnings).toContain("and the parent's default partition, when it has one, either way")
	})

	it("names the storage moves that rewrite, and none to where the relation already is", () => {
		expect(warnings).toContain(
			"a `SET TABLESPACE`, `SET ACCESS METHOD`, `SET LOGGED` or `SET UNLOGGED`, which rewrites",
		)
		expect(warnings).toContain("none for a move to where the relation already is: where the history left it")
	})

	it("says check and apply read where the target's default put a relation (PA17 of r22b, 16.3 c)", () => {
		expect(warnings).toContain(
			"where the target's catalog says its default put it, which `check` and `apply` read when the `postgres` package is installed",
		)
		expect(warnings).toContain("for a relation a pending file makes, such a move warns")
	})
})

describe("the README on the locks only check's replay measures (AE2-13)", () => {
	it("tells the apply paragraph's reader to run check on a postgres:// devUrl before apply", () => {
		const advice = sentence(
			paragraph("`apply` works on a private copy of the migrations directory"),
			"run `check` on a `postgres://` `devUrl` before `apply`",
		)
		expect(advice).toContain("a lock a `DO` block, a function or `EXECUTE` takes")
		expect(advice).toContain("a table a `DO` block renamed")
	})

	it("leaves the advice out of the 0.21 upgrade item, which installed docs strip", () => {
		const item = /^74\. [^\n]*$/m.exec(upgrade)?.[0]
		expect(item).toContain("**Fix:** none")
		expect(item).not.toContain("before `apply`")
	})
})

describe("the README on Postgres's outside-transaction statements (PA14 of r22b)", () => {
	const list = sentence(
		paragraph("A statement Postgres runs only outside a transaction needs its own file"),
		"`check` reads which from the parse tree",
	)

	it("names a partitioned table's or index's CLUSTER and REINDEX, beside the bare CLUSTER", () => {
		expect(list).toContain("a bare `CLUSTER`")
		expect(list).toContain("a `CLUSTER`, `REINDEX TABLE` or `REINDEX INDEX` of a partitioned table or index")
		expect(list).toContain("`REINDEX SCHEMA`, `DATABASE` or `SYSTEM`")
	})

	it("tells a 0.20 history to move a partitioned table's CLUSTER or REINDEX into a txmode none file", () => {
		const item = /^\d+\. \*\*Move a partitioned table's `CLUSTER` or `REINDEX`[^\n]*$/m.exec(upgrade)?.[0]
		expect(item).toContain("`CLUSTER`, `REINDEX TABLE` or `REINDEX INDEX` of a partitioned table or index")
		expect(item).toContain("**Fix:** move each into a file of its own that starts with `-- atlas:txmode none`")
	})
})

describe("the README on status and an applied file edited since (PA21 of r22b)", () => {
	const status = sentence(paragraph("`baseline <db>` records every file"), "`status <db>` lists")

	it("says status refuses it, naming the file, and never that it warns", () => {
		expect(status).toContain("refuses an applied file edited since, naming it")
		expect(status).not.toContain("warns")
	})
})
