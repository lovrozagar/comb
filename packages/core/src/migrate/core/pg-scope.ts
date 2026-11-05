/**
 * A Postgres file's statements read in order for where each runs: what Postgres runs only outside a
 * transaction, and only inside a block, the file's own BEGIN followed, as Postgres sees a txmode none
 * file's (PA13 of r22b). A txmode none file commits each statement outside its own BEGIN, and the
 * locks it took with it, so the locks any of them holds end there (PA8 and 0005 of r22b).
 */
import type { ReadStatement } from "./classify-file.ts"
import { type Facts, tableOf } from "./pg-history.ts"
import { blockAfter, insideOnly, nodeOf, outsideOnly, transactionControl } from "./pg-outside-transaction.ts"
import { partitionedRefusal } from "./pg-partitioned.ts"
import { clearHeld, type Held } from "./pg-held.ts"

/** Whether a table, or an index, the history `facts` follow is partitioned */
const partitionedIn =
	(facts: Facts) =>
	(relation: unknown, index: boolean): boolean => {
		const { key } = tableOf(relation, facts.schema)
		return facts.partitioned.has(index ? (facts.indexes.get(key)?.table ?? "") : key)
	}

/** A reader of a file's statements in order, the file outside a transaction when `bare` */
function scopeReader(
	bare: boolean,
	{ facts, held }: { facts: Facts; held: Held },
): (tree: unknown) => Pick<ReadStatement, "control" | "inside" | "outside" | "refused"> {
	let block = false
	const partitioned = partitionedIn(facts)
	return (tree) => {
		if (bare && !block) clearHeld(held)
		const parsed = nodeOf(tree)
		const inside = block ? undefined : insideOnly(...parsed)
		block = blockAfter(block, ...parsed)
		/* before the statement's findings follow what it makes: a table partitioned so far (P9 of r21) */
		return {
			control: transactionControl(...parsed),
			inside,
			outside: outsideOnly(...parsed, partitioned),
			refused: partitionedRefusal(...parsed, facts),
		}
	}
}

export { scopeReader }
