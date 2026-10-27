/**
 * Names inside `CREATE SCHEMA s …` elements as Postgres resolves them (M74). CreateSchemaCommand
 * puts s first on the search path, and s is new, so an unqualified name in an element resolves to
 * s only when an element of the statement creates it; any other resolves as it would outside the
 * statement. The parse tree is qualified so on parsing, before anything reads or keeps it.
 */

/** A relation a parse tree names: its name and, when written, its schema */
type RangeVar = { relname: string; schemaname?: string | undefined }

// lookup-table: the elements that create a relation, and the field that names it
const CREATES: Readonly<Record<string, string>> = {
	CreateSeqStmt: "sequence",
	CreateStmt: "relation",
	ViewStmt: "view",
}

/** Every relation `node` names, at any depth */
function rangeVars(node: unknown, out: RangeVar[] = []): RangeVar[] {
	if (Array.isArray(node)) for (const each of node) rangeVars(each, out)
	else if (node !== null && typeof node === "object") {
		if (typeof (node as RangeVar).relname === "string") out.push(node as RangeVar)
		for (const value of Object.values(node)) rangeVars(value, out)
	}
	return out
}

/** The relations `elements` create, by name */
const created = (elements: readonly Record<string, Record<string, RangeVar>>[]): Set<string> =>
	new Set(
		elements.flatMap((element) =>
			Object.entries(element).flatMap(([type, node]) => {
				const field = CREATES[type]
				return field === undefined ? [] : [(node[field] as RangeVar).relname]
			}),
		),
	)

type CreateSchema = {
	authrole?: { rolename?: string }
	schemaElts?: Array<Record<string, Record<string, RangeVar>>>
	schemaname?: string
}

/** Qualify, in the fresh parse tree `stmts`, each unqualified relation a CREATE SCHEMA element names that the statement creates */
function qualifySchemaElements(stmts: unknown): void {
	for (const raw of (stmts ?? []) as Array<{ stmt?: { CreateSchemaStmt?: CreateSchema } }>) {
		const schema = raw.stmt?.CreateSchemaStmt
		const elements = schema?.schemaElts ?? []
		const name = schema?.schemaname ?? schema?.authrole?.rolename
		const own = created(elements)
		for (const relation of rangeVars(elements))
			if (relation.schemaname === undefined && own.has(relation.relname)) relation.schemaname = name
	}
}

export { qualifySchemaElements }
