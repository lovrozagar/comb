/**
 * The columns of a Postgres history that own a sequence: a serial column, an identity column, and a
 * column a sequence's OWNED BY names. A DROP of the column or its table drops the sequence without
 * CASCADE and locks it, so the map says it locks the sequences such a table owns (pg-drop.ts).
 */
import { type ColumnType, type Facts, keyOf, names, type Node } from "./pg-nodes.ts"

/* the types a column made with owns a sequence, as Postgres reads them only unqualified */
const SERIALS = /^(?:smallserial|serial[248]?|bigserial)$/

/**
 * `type`, the column `def` defines, owning a sequence when `def` makes one, a serial type or
 * GENERATED … AS IDENTITY, or when the column `was` did: a retype keeps the column's sequence
 */
function owned(def: Node, type: ColumnType, was: ColumnType | undefined): ColumnType {
	const parts = names((def["typeName"] as Node)["names"])
	const constraints = (def["constraints"] as Array<{ Constraint: Node }> | undefined) ?? []
	const owns =
		was?.owns === true ||
		(parts.length === 1 && SERIALS.test(parts[0] as string)) ||
		constraints.some(({ Constraint }) => Constraint["contype"] === "CONSTR_IDENTITY")
	return owns ? { ...type, owns: true } : type
}

/** The column `column` of `table` in `facts`, owning a sequence from now on */
function own(table: string, column: string, facts: Facts): void {
	const type = facts.columnTypes.get(table)?.get(column)
	if (type !== undefined) facts.columnTypes.get(table)?.set(column, { ...type, owns: true })
}

/** `facts` after an ALTER TABLE's ADD GENERATED … AS IDENTITY; whether `cmd` was one */
function followIdentity(table: string, cmd: Node, facts: Facts): boolean {
	if (cmd["subtype"] !== "AT_AddIdentity") return false
	own(table, String(cmd["name"]), facts)
	return true
}

/** `facts` after a CREATE or ALTER SEQUENCE's OWNED BY a column; whether `type` was either */
function followSequence(type: string, node: Node, facts: Facts): boolean {
	if (type !== "CreateSeqStmt" && type !== "AlterSeqStmt") return false
	for (const { DefElem } of (node["options"] as Array<{ DefElem: Node }> | undefined) ?? []) {
		if (DefElem["defname"] !== "owned_by") continue
		const parts = names(((DefElem["arg"] as Node)["List"] as Node)["items"])
		/* OWNED BY NONE names no column */
		if (parts.length > 1) own(keyOf(parts.slice(0, -1), facts.schema), parts.at(-1) as string, facts)
	}
	return true
}

export { followIdentity, followSequence, owned }
