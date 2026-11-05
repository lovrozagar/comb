/**
 * The README's Postgres migrate paragraphs say what comb does (nits of r22b, plan 21 leaf 10.8):
 * the outside-transaction list names every statement check refuses in a file Atlas runs in one
 * transaction (PA14, pg-outside-transaction.ts), with a 0.21 upgrade note for the partitioned ones
 * 0.20 added; and `status` refuses an applied file edited since, as checkHistory does (PA21,
 * atlas-history.ts), where the README said it warned. Sibling: the session paragraph
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
