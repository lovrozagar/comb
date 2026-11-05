/**
 * What a Postgres history proves of a partition's rows before an ATTACH PARTITION (PA16 of r22b):
 * Postgres 17 skips the scan of the partition when its validated CHECK constraints and NOT NULL
 * columns imply the partition constraint (PartConstraintImpliedByRelConstraint, which logs "partition
 * constraint for table … is implied by existing constraints" at DEBUG1). comb proves the implication
 * only where predtest proves it by equal clauses: a single-column RANGE or LIST key with no COLLATE or
 * operator class of its own, the key column NOT NULL, and a CHECK term that is the bound's own clause
 * (the key `>=` the lower bound and `<` the upper one, or `IN` values the list holds), each constant
 * one whose input reads the same in every session (an integer; an ISO date or timestamp; a string,
 * for text and varchar). A CHECK counts only when every term of it is such a comparison, so nothing
 * but a change of its columns or its own drop removes it; NOT VALID and NO INHERIT ones do not count
 * until a VALIDATE. A DROP CONSTRAINT, DROP NOT NULL, or a drop, retype or rename of a column forgets
 * what the history proved of the table and every table under it, which inherit the change.
 *
 * The ATTACH still builds on the partition each index of the parent and validates each of its foreign
 * keys, so the scan is skipped only for a parent the history shows has neither, made without LIKE
 * and itself no partition or child.
 */
import { type Facts, flag, keyOf, names, type Node, type Term, tableOf } from "./pg-nodes.ts"

/** A constant as the parser writes it, with its kind: `i:` an integer, `s:` a string; undefined for any other */
function constant(node: unknown): string | undefined {
	const value = (node as Node | undefined)?.["A_Const"] as Node | undefined
	if (value === undefined || flag(value["isnull"])) return undefined
	if (value["ival"] !== undefined) return `i:${String((value["ival"] as Node)["ival"] ?? 0)}`
	const float = (value["fval"] as Node | undefined)?.["fval"]
	if (typeof float === "string") return /^-?\d+$/.test(float) ? `i:${float}` : undefined
	const text = (value["sval"] as Node | undefined)?.["sval"]
	return typeof text === "string" ? `s:${text}` : undefined
}

/** The one column a ColumnRef names, undefined for any other node */
function columnOf(node: unknown): string | undefined {
	const fields = ((node as Node | undefined)?.["ColumnRef"] as Node | undefined)?.["fields"] as Node[] | undefined
	const [only] = fields ?? []
	return fields?.length === 1 ? ((only?.["String"] as Node | undefined)?.["sval"] as string | undefined) : undefined
}

// lookup-table: each comparison a term may make, by its operator, and the one it is with its sides swapped
const FLIPPED: Readonly<Record<string, Term["op"]>> = { "<": ">", "<=": ">=", "=": "=", ">": "<", ">=": "<=" }

/** A comparison of a column with a constant, either way round; undefined for any other */
function comparison(node: Node, facts: Facts): Term | undefined {
	const operator = names(node["name"])
	const [op] = operator
	if (operator.length !== 1 || op === undefined || FLIPPED[op] === undefined) return undefined
	/* an operator a migration defined may be the one the CHECK resolved to */
	if ([...facts.operators.keys()].some((key) => key.split(".").at(-1) === op)) return undefined
	const [left, right] = [node["lexpr"], node["rexpr"]]
	const [column, value] = [columnOf(left), constant(right)]
	if (column !== undefined && value !== undefined) return { column, op: op as Term["op"], values: [value] }
	const [flippedColumn, flippedValue] = [columnOf(right), constant(left)]
	if (flippedColumn === undefined || flippedValue === undefined) return undefined
	return { column: flippedColumn, op: FLIPPED[op] as Term["op"], values: [flippedValue] }
}

/** A CHECK's terms: each conjunct a comparison, an IN list or an IS NOT NULL of one column; undefined when any is not */
function termsOf(expr: unknown, facts: Facts): Term[] | undefined {
	const node = expr as Node
	const bool = node["BoolExpr"] as Node | undefined
	if (bool !== undefined) {
		if (bool["boolop"] !== "AND_EXPR") return undefined
		const each = (bool["args"] as unknown[]).map((arg) => termsOf(arg, facts))
		return each.some((terms) => terms === undefined) ? undefined : (each as Term[][]).flat()
	}
	const test = node["NullTest"] as Node | undefined
	if (test !== undefined) {
		const column = columnOf(test["arg"])
		return test["nulltesttype"] === "IS_NOT_NULL" && column !== undefined
			? [{ column, op: "notnull", values: [] }]
			: undefined
	}
	const compared = node["A_Expr"] as Node | undefined
	if (compared?.["kind"] === "AEXPR_OP") {
		const term = comparison(compared, facts)
		return term === undefined ? undefined : [term]
	}
	if (compared?.["kind"] !== "AEXPR_IN" || names(compared["name"]).join() !== "=") return undefined
	const column = columnOf(compared["lexpr"])
	const values = (((compared["rexpr"] as Node)["List"] as Node)["items"] as unknown[]).map(constant)
	if (column === undefined || values.some((value) => value === undefined)) return undefined
	return [{ column, op: "in", values: values as string[] }]
}

/** What the history proved of `table`, made empty when it held nothing yet */
function proofOf(facts: Facts, table: string) {
	const proof = facts.proofs.get(table) ?? { checks: [], notNull: new Set<string>() }
	facts.proofs.set(table, proof)
	return proof
}

/** A constraint `table` gained, on `column` when it is a column's: a CHECK's terms, or a NOT NULL or primary key's columns */
function constrained(
	facts: Facts,
	table: string,
	{ column, constraint }: { column?: string | undefined; constraint: Node },
): void {
	const proof = proofOf(facts, table)
	const type = constraint["contype"]
	/* a column's NOT NULL or PRIMARY KEY names no keys: it is its column's; Postgres 17 writes no NOT NULL of a table */
	if (column !== undefined && (type === "CONSTR_NOTNULL" || type === "CONSTR_PRIMARY")) proof.notNull.add(column)
	else if (type === "CONSTR_PRIMARY" && constraint["indexname"] === undefined)
		for (const key of names(constraint["keys"])) proof.notNull.add(key)
	else if (type === "CONSTR_CHECK" && !flag(constraint["is_no_inherit"])) {
		const terms = termsOf(constraint["raw_expr"], facts)
		if (terms === undefined) return
		const name = constraint["conname"] as string | undefined
		proof.checks.push({ name, terms, valid: !flag(constraint["skip_validation"]) })
	}
}

/** A column's own constraints */
function columnConstraints(facts: Facts, table: string, def: Node): void {
	for (const each of (def["constraints"] as Node[] | undefined) ?? [])
		constrained(facts, table, { column: String(def["colname"]), constraint: each["Constraint"] as Node })
}

/** `table` and every table under it, by partition or inheritance, which a change of its columns or constraints reaches */
function under(facts: Facts, table: string): string[] {
	const children = [...facts.parents]
		.filter(([, parents]) => parents.some((each) => each.parent === table))
		.map(([child]) => child)
	return [table, ...children.flatMap((child) => under(facts, child))]
}

/** Forget what the history proved of `table` and every table under it */
function forget(facts: Facts, table: string): void {
	for (const each of under(facts, table)) facts.proofs.delete(each)
}

// lookup-table: the partition strategies whose bounds comb proves, as a bound of each writes its own
const STRATEGIES: Readonly<Record<string, "l" | "r">> = { PARTITION_STRATEGY_LIST: "l", PARTITION_STRATEGY_RANGE: "r" }

/** A CREATE TABLE's partition key, when the bound of a partition attached to it is one comb proves */
function partitionKey(node: Node, elements: Node[]): { column: string; strategy: "l" | "r" } | undefined {
	const spec = node["partspec"] as Node | undefined
	const params = ((spec?.["partParams"] as Node[] | undefined) ?? []).map((each) => each["PartitionElem"] as Node)
	const [key] = params
	const strategy = STRATEGIES[String(spec?.["strategy"])]
	const plain =
		params.length === 1 &&
		key?.["collation"] === undefined &&
		key?.["opclass"] === undefined &&
		node["inhRelations"] === undefined &&
		elements.every((element) => element["TableLikeClause"] === undefined)
	const name = key?.["name"]
	return plain && strategy !== undefined && typeof name === "string" ? { column: name, strategy } : undefined
}

/** A CREATE TABLE: its key, when the bound of a partition attached to it is one comb proves, and its constraints */
function made(facts: Facts, node: Node): void {
	const table = tableOf(node["relation"], facts.schema).key
	if (flag(node["if_not_exists"]) && facts.proofs.has(table)) return
	facts.proofs.delete(table)
	facts.partitionKeys.delete(table)
	const elements = (node["tableElts"] as Node[] | undefined) ?? []
	const key = partitionKey(node, elements)
	if (key !== undefined) facts.partitionKeys.set(table, key)
	proofOf(facts, table)
	for (const element of elements) {
		if (element["ColumnDef"] !== undefined) columnConstraints(facts, table, element["ColumnDef"] as Node)
		if (element["Constraint"] !== undefined) constrained(facts, table, { constraint: element["Constraint"] as Node })
	}
}

// lookup-table: the ALTER TABLE commands that remove a constraint or change a column a CHECK may name
const FORGETS = /* @__PURE__ */ new Set(["AT_AlterColumnType", "AT_DropColumn", "AT_DropConstraint", "AT_DropNotNull"])

/** An ALTER TABLE's constraints added, validated, set NOT NULL, or removed */
function altered(facts: Facts, node: Node): void {
	if (node["objtype"] !== "OBJECT_TABLE") return
	const table = tableOf(node["relation"], facts.schema).key
	for (const each of node["cmds"] as Node[]) {
		const cmd = each["AlterTableCmd"] as Node
		const subtype = String(cmd["subtype"])
		const def = cmd["def"] as Node | undefined
		if (FORGETS.has(subtype)) forget(facts, table)
		else if (subtype === "AT_AddConstraint") constrained(facts, table, { constraint: def?.["Constraint"] as Node })
		else if (subtype === "AT_AddColumn") columnConstraints(facts, table, def?.["ColumnDef"] as Node)
		else if (subtype === "AT_SetNotNull") proofOf(facts, table).notNull.add(String(cmd["name"]))
		else if (subtype === "AT_ValidateConstraint")
			for (const check of facts.proofs.get(table)?.checks ?? []) if (check.name === cmd["name"]) check.valid = true
	}
}

/** A column or constraint renamed on `table`, which reaches every table under it */
function renamed(facts: Facts, node: Node): void {
	const table = tableOf(node["relation"], facts.schema).key
	const [from, to] = [String(node["subname"]), String(node["newname"])]
	if (node["renameType"] === "OBJECT_COLUMN") {
		for (const each of under(facts, table))
			if (facts.partitionKeys.get(each)?.column === from) facts.partitionKeys.delete(each)
		forget(facts, table)
	} else
		for (const each of under(facts, table))
			for (const check of facts.proofs.get(each)?.checks ?? []) if (check.name === from) check.name = to
}

/** Whether `key` names a relation in `schema` */
const inSchema = (key: string, schema: string, facts: Facts): boolean =>
	key.includes(".") ? key.slice(0, key.indexOf(".")) === schema : schema === facts.schema

/** A DROP SCHEMA: what the history proved of each table in the schemas it drops */
function droppedSchemas(facts: Facts, node: Node): void {
	for (const object of node["objects"] as Node[]) {
		const schema = keyOf([String((object["String"] as Node)["sval"])], facts.schema)
		for (const map of [facts.proofs, facts.partitionKeys])
			for (const key of map.keys()) if (inSchema(key, schema, facts)) map.delete(key)
	}
}

/** `facts.proofs` and `facts.partitionKeys` after one statement; a table's rename and drop are pg-names.ts's */
function followBounds(type: string, node: Node, facts: Facts): void {
	if (type === "CreateStmt") made(facts, node)
	else if (type === "AlterTableStmt") altered(facts, node)
	else if (
		type === "RenameStmt" &&
		(node["renameType"] === "OBJECT_COLUMN" || node["renameType"] === "OBJECT_TABCONSTRAINT")
	)
		renamed(facts, node)
	else if (type === "DropStmt" && node["removeType"] === "OBJECT_SCHEMA") droppedSchemas(facts, node)
}

/** A bound's datum: a constant, `minvalue` or `maxvalue`, or undefined for any other */
function datum(node: unknown): string | undefined {
	const word = columnOf(node)
	return word === "minvalue" || word === "maxvalue" ? word : constant(node)
}

// lookup-table: the key column types comb proves a bound on, and what a constant of each must be to read the same in every session
const SESSION_FREE: Readonly<Record<string, RegExp>> = {
	date: /^s:\d{4}-\d{2}-\d{2}$/,
	int2: /^i:-?\d+$/,
	int4: /^i:-?\d+$/,
	int8: /^i:-?\d+$/,
	text: /^s:/,
	timestamp: /^s:\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}:\d{2})?$/,
	varchar: /^s:/,
}

/* predtest expands an IN list into its values only up to MAX_SAOP_ARRAY_SIZE */
const MAX_SAOP_ARRAY_SIZE = 100

/** Whether `terms` hold the clause each datum of the bound, a list or range one, makes; `pattern` is what a constant of the key's type must be */
function holds(terms: Term[], bound: Node, pattern: RegExp): boolean {
	const has = (op: Term["op"], value: string) => terms.some((term) => term.op === op && term.values[0] === value)
	const fits = (value: string | undefined) => value !== undefined && pattern.test(value)
	if (bound["strategy"] === "l") {
		const values = (bound["listdatums"] as unknown[]).map(constant)
		if (values.length > MAX_SAOP_ARRAY_SIZE || !values.every(fits)) return false
		return terms.some(
			(term) =>
				(term.op === "in" || term.op === "=") &&
				term.values.length <= MAX_SAOP_ARRAY_SIZE &&
				term.values.every((value) => values.includes(value)),
		)
	}
	const [lowers, uppers] = [bound["lowerdatums"] as unknown[], bound["upperdatums"] as unknown[]]
	/* a bound of more values than the single-column key, which Postgres refuses */
	if (lowers.length !== 1 || uppers.length !== 1) return false
	const [lower, upper] = [datum(lowers[0]), datum(uppers[0])]
	const lowerHolds = lower === "minvalue" || (fits(lower) && has(">=", lower as string))
	return lowerHolds && (upper === "maxvalue" || (fits(upper) && has("<", upper as string)))
}

/** Whether `parent` gives `partition` nothing to build or validate as it attaches: no index, no foreign key, no parent of its own */
const bare = (facts: Facts, parent: string): boolean =>
	![...facts.indexes.values()].some((index) => index.table === parent) &&
	!facts.foreignKeys.some((key) => key.table === parent) &&
	(facts.parents.get(parent) ?? []).length === 0

/**
 * Whether an ATTACH of `partition` to `parent` with `bound` scans nothing of `partition`: its validated
 * CHECKs and NOT NULL key column imply the bound, and the parent gives it nothing to build or validate
 */
function boundImplied(
	facts: Facts,
	{ bound, parent, partition }: { bound: Node; parent: string; partition: string },
): boolean {
	const { column: key, strategy } = facts.partitionKeys.get(parent) ?? {}
	const proof = facts.proofs.get(partition)
	const type = key === undefined ? undefined : facts.columnTypes.get(partition)?.get(key)
	const pattern = type === undefined || type.dims > 0 ? undefined : SESSION_FREE[type.type]
	/* a bound of another strategy than the parent's, a hash or default one among them, is one Postgres refuses */
	if (key === undefined || bound["strategy"] !== strategy) return false
	if (proof === undefined || pattern === undefined || !bare(facts, parent)) return false
	const terms = proof.checks
		.filter((check) => check.valid)
		.flatMap((check) => check.terms.filter((term) => term.column === key))
	const notNull = proof.notNull.has(key) || terms.some((term) => term.op === "notnull")
	return notNull && holds(terms, bound, pattern)
}

export { boundImplied, followBounds }
