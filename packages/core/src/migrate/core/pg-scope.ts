/**
 * A Postgres file's statements read in order for where each runs: what Postgres runs only outside a
 * transaction, and only inside a block, the file's own BEGIN followed, as Postgres sees a txmode none
 * file's. A txmode none file commits each statement outside its own BEGIN, and the
 * locks it took with it, so the locks any of them holds end there.
 */
import type { ReadStatement } from "./classify-file.ts"
import { type Facts, tableOf } from "./pg-history.ts"
import { blockAfter, insideOnly, nodeOf, outsideOnly, transactionControl } from "./pg-outside-transaction.ts"
import { copyRefusal } from "./pg-copy.ts"
import { partitionedRefusal } from "./pg-partitioned.ts"
import { clearHeld, type Held } from "./pg-held.ts"

/** Whether a table, or an index, the history `facts` follow is partitioned */
const partitionedIn =
	(facts: Facts) =>
	(relation: unknown, index: boolean): boolean => {
		const { key } = tableOf(relation, facts.schema)
		return facts.partitioned.has(index ? (facts.indexes.get(key)?.table ?? "") : key)
	}

/**
 * A reader of a file's statements in order, the file outside a transaction when `bare`; one check
 * `replays` on devUrl leaves to Postgres what a partitioned table or index refuses in a transaction
 * block, as the history's text cannot show what a DO block partitions (pg-replay-statement.ts)
 */
function scopeReader(
	bare: boolean,
	{ facts, held }: { facts: Facts; held: Held },
	replays = false,
): (tree: unknown) => Pick<ReadStatement, "control" | "inside" | "outside" | "refused"> {
	let block = false
	const partitioned = replays ? () => false : partitionedIn(facts)
	return (tree) => {
		if (bare && !block) clearHeld(held)
		const parsed = nodeOf(tree)
		const inside = block ? undefined : insideOnly(...parsed)
		block = blockAfter(block, ...parsed)
		/* before the statement's findings follow what it makes: a table partitioned so far */
		return {
			control: transactionControl(...parsed),
			inside,
			outside: outsideOnly(...parsed, partitioned),
			refused: partitionedRefusal(...parsed, facts) ?? copyRefusal(...parsed),
		}
	}
}

export { scopeReader }
