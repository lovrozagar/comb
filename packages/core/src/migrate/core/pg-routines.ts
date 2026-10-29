/**
 * The functions and procedures a Postgres history leaves, by key and signature: a CREATE adds its
 * signature, a DROP takes one away (or every one of a name dropped without its arguments), and a
 * rename or a move to another schema carries a signature to its new key, as a schema renamed
 * carries every key under it. A name is defined while a signature of it is left, so a dropped
 * overload leaves its siblings (5.4b). Each signature keeps the volatility its CREATE or a later
 * ALTER FUNCTION gave it, VOLATILE unless one said otherwise, which an added column's default needs
 * (P8 of the 0.15.0 review). `Facts.defined` is the other view, every name ever defined, which
 * reading a call needs (M83).
 */
import { movedKey } from "./pg-names.ts"
import { type Facts, keyOf, names, type Node, type Routines, typeOf, type Volatility } from "./pg-nodes.ts"

// lookup-table: the parameter modes a signature leaves out, as Postgres does in identifying a routine
const OUTPUT_MODES: ReadonlySet<string> = /* @__PURE__ */ new Set(["FUNC_PARAM_OUT", "FUNC_PARAM_TABLE"])

// lookup-table: the kinds of drop, rename and move that name a function or procedure
const ROUTINE_KINDS: ReadonlySet<string> = /* @__PURE__ */ new Set([
	"OBJECT_FUNCTION",
	"OBJECT_PROCEDURE",
	"OBJECT_ROUTINE",
])

/**
 * A routine's signature: its input arguments' types, each array counting its bounds; a `%TYPE`
 * argument as written, marked so, since the column it names holds the type Postgres stores
 */
function signatureOf(parameters: unknown, schema: string): string {
	return ((parameters as Node[] | undefined) ?? [])
		.map((parameter) => parameter["FunctionParameter"] as Node)
		.filter((parameter) => !OUTPUT_MODES.has(String(parameter["mode"])))
		.map((parameter) => {
			const type = parameter["argType"] as Node
			const bounds = "[]".repeat(((type["arrayBounds"] as unknown[] | undefined) ?? []).length)
			return `${typeOf(type, schema)}${type["pct_type"] === true ? "%TYPE" : ""}${bounds}`
		})
		.join(",")
}

/** What an ObjectWithArgs names: the routine's key, and its signature, or undefined for every one of the name */
function named(object: unknown, schema: string): { key: string; signature: string | undefined } {
	const routine = (object as Node)["ObjectWithArgs"] as Node
	const key = keyOf(names(routine["objname"]), schema)
	return {
		key,
		signature: routine["args_unspecified"] === true ? undefined : signatureOf(routine["objfuncargs"], schema),
	}
}

/** Take a signature, or every one of the key, away; the signatures taken, with their volatility */
function take(routines: Routines, { key, signature }: ReturnType<typeof named>): Array<[string, Volatility]> {
	const routine = routines.get(key)
	if (routine === undefined) return []
	const taken = [...routine.signatures].filter(([each]) => signature === undefined || each === signature)
	for (const [each] of taken) routine.signatures.delete(each)
	if (routine.signatures.size === 0) routines.delete(key)
	return taken
}

type Signatures = { kind: "function" | "procedure"; signatures: ReadonlyArray<[string, Volatility]> }

/** Put signatures under a key, of the kind the routine is; none, as a rename of a routine the history never made moves, puts nothing */
function put(routines: Routines, key: string, routine: Signatures): void {
	if (routine.signatures.length === 0) return
	const at = routines.get(key) ?? { kind: routine.kind, signatures: new Map<string, Volatility>() }
	for (const [signature, volatility] of routine.signatures) at.signatures.set(signature, volatility)
	routines.set(key, at)
}

/** The volatility `options`, a CREATE's options or an ALTER's actions (each always has some), set; undefined where they set none */
const volatilityOf = (options: unknown): Volatility | undefined =>
	(options as Node[])
		.map((each) => each["DefElem"] as Node)
		.filter((elem) => elem["defname"] === "volatility")
		.map((elem) => String(((elem["arg"] as Node)["String"] as Node)["sval"]) as Volatility)
		.at(-1)

/** An ALTER FUNCTION that sets a volatility: the signatures it names take it */
function alterVolatility(node: Node, facts: Facts): void {
	const volatility = volatilityOf(node["actions"])
	if (volatility === undefined) return
	const was = named({ ObjectWithArgs: node["func"] }, facts.schema)
	const routine = facts.routines.get(was.key)
	if (routine === undefined) return
	for (const signature of routine.signatures.keys())
		if (was.signature === undefined || signature === was.signature) routine.signatures.set(signature, volatility)
}

/** A rename or a move to another schema: the signature it names goes to its new key */
function move(type: string, node: Node, facts: Facts): void {
	const was = named(node["object"], facts.schema)
	const kind = facts.routines.get(was.key)?.kind ?? "function"
	const parts = names(((node["object"] as Node)["ObjectWithArgs"] as Node)["objname"])
	const to = keyOf(
		type === "RenameStmt"
			? [...parts.slice(0, -1), String(node["newname"])]
			: [String(node["newschema"]), parts.at(-1) as string],
		facts.schema,
	)
	put(facts.routines, to, { kind, signatures: take(facts.routines, was) })
}

/** A schema renamed: every routine under it moves with it */
function moveSchema(facts: Facts, from: string, to: string): void {
	for (const [key, routine] of Array.from(facts.routines)) {
		const moved = movedKey(key, { from, to }, facts.schema)
		if (moved === undefined) continue
		facts.routines.delete(key)
		put(facts.routines, moved, { kind: routine.kind, signatures: [...routine.signatures] })
	}
}

/** `facts.routines` after a statement that defines, alters, drops, renames or moves a function or procedure */
function followRoutine(type: string, node: Node, facts: Facts): void {
	if (type === "CreateFunctionStmt") {
		const kind = node["is_procedure"] === true ? "procedure" : "function"
		const signature = signatureOf(node["parameters"], facts.schema)
		const volatility = volatilityOf(node["options"]) ?? "volatile"
		put(facts.routines, keyOf(names(node["funcname"]), facts.schema), { kind, signatures: [[signature, volatility]] })
	} else if (type === "AlterFunctionStmt") {
		alterVolatility(node, facts)
	} else if (type === "DropStmt" && ROUTINE_KINDS.has(String(node["removeType"]))) {
		for (const object of node["objects"] as unknown[]) take(facts.routines, named(object, facts.schema))
	} else if (type === "RenameStmt" && node["renameType"] === "OBJECT_SCHEMA") {
		moveSchema(facts, String(node["subname"]), String(node["newname"]))
	} else if (
		(type === "RenameStmt" && ROUTINE_KINDS.has(String(node["renameType"]))) ||
		(type === "AlterObjectSchemaStmt" && ROUTINE_KINDS.has(String(node["objectType"])))
	) {
		move(type, node, facts)
	}
}

export { followRoutine }
