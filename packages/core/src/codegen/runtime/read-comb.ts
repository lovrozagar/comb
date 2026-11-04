/** What the runtime reader reads of a c helper's own record: its constraints and an enum's state machine, as JSON */
import type { SnapshotComb } from "./snapshot-types.ts"

const STRING_LIST = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every((item) => typeof item === "string")

/** A c helper's constraints as JSON, every value a primitive; an error naming the column otherwise */
function constraintsOf(raw: unknown, at: string): Record<string, boolean | number | string> {
	const constraints: Record<string, boolean | number | string> = {}
	for (const [key, value] of Object.entries((raw ?? {}) as Record<string, unknown>)) {
		if (value === undefined) continue
		if (typeof value !== "boolean" && typeof value !== "number" && typeof value !== "string")
			throw new Error(`${at}: the constraint ${key} is a ${typeof value}; comb reads a boolean, a number or a string`)
		/* JSON carries no NaN or Infinity: the snapshot would hold null, and the bound would drop without a word (F60) */
		if (typeof value === "number" && !Number.isFinite(value))
			throw new Error(
				`${at}: the constraint ${key} is ${value}, no finite number; a bound read from the environment is NaN in codegen's child, which has none of it`,
			)
		constraints[key] = value
	}
	return constraints
}

/* the keys a c.enum's state machine has; values, which docs/state-machines.md §4 holds in the same const, read from c.enum's second argument */
const STATE_KEYS = ["initial", "terminal", "transitions", "values"]

/** What fills a column a write leaves out: a value or SQL default, a default function, an update function */
type Fill = { default?: unknown; defaultFn?: unknown; onUpdateFn?: unknown }

/**
 * A state column's fill is its machine's `initial`, the value a row starts at (CD4 of r22b): a
 * literal default other than it, or a fill comb cannot read as a value, is an error naming the column;
 * a machine that declares no `initial` starts anywhere
 */
function refuseOtherStart(initial: string | null, fill: Fill, at: string): void {
	if (initial === null) return
	const literal = fill.defaultFn === undefined && fill.onUpdateFn === undefined && typeof fill.default !== "object"
	if (!literal)
		throw new Error(
			`${at}: its default is no literal value, so comb cannot hold it to its state machine's initial "${initial}"; write .default("${initial}")`,
		)
	if (fill.default !== undefined && fill.default !== initial)
		throw new Error(
			`${at}: its default ${JSON.stringify(fill.default)} is not its state machine's initial "${initial}"; a row starts at initial`,
		)
}

/**
 * A c.enum column's state machine as JSON; an error naming the column for one of another shape, or
 * for a fill other than its `initial`
 */
function statesOf(raw: unknown, at: string, fill: Fill = {}): SnapshotComb["states"] {
	if (raw === undefined) return null
	/* a misspelt key would leave its part of the machine unread (F9) */
	const unknown = Object.keys(raw as object).find((key) => !STATE_KEYS.includes(key))
	if (unknown !== undefined)
		throw new Error(
			`${at}: its state machine has ${unknown}, which is none of initial, terminal, transitions and values`,
		)
	const { initial, terminal, transitions } = raw as Record<string, unknown>
	/* an entry set to undefined is the key left out, as canTransition reads it (D2-3 of the area D round-two review) */
	const map =
		transitions === undefined
			? undefined
			: Object.fromEntries(Object.entries(transitions as object).filter(([, to]) => to !== undefined))
	const valid =
		(initial === undefined || typeof initial === "string") &&
		(terminal === undefined || STRING_LIST(terminal)) &&
		(map === undefined || Object.values(map).every(STRING_LIST))
	if (!valid) throw new Error(`${at}: its state machine is not { initial?, terminal?, transitions? } of state names`)
	refuseOtherStart((initial as string | undefined) ?? null, fill, at)
	return {
		initial: (initial as string | undefined) ?? null,
		terminal: (terminal as string[] | undefined) ?? null,
		transitions: (map as Record<string, string[]> | undefined) ?? null,
	}
}

/** A zod schema as its public definition reads: a kind, and the schemas it holds among its other entries; a check has none */
type ZodNode = { def: Record<string, unknown> & { type: string } }

const isZodNode = (value: unknown): value is ZodNode =>
	typeof value === "object" && value !== null && typeof (value as Partial<ZodNode>).def?.type === "string"

/** The values a definition entry holds: an array's items, a shape's fields, or the entry itself */
const heldBy = (entry: unknown): unknown[] => {
	if (Array.isArray(entry)) return entry
	if (typeof entry === "object" && entry !== null && Object.getPrototypeOf(entry) === Object.prototype)
		return Object.values(entry)
	return [entry]
}

/**
 * Whether `schema` holds, anywhere in it, a part whose output is another value than its input: a
 * transform, a pipe, which `.transform()`, `z.preprocess()` and a codec each build. An overwrite
 * (`.trim()`, `.toLowerCase()`), a default and a coerce hand on what the same part parses again
 */
function changesValue(schema: unknown): boolean {
	const seen = new Set<unknown>()
	const pending = [schema]
	while (pending.length > 0) {
		const node = pending.pop()
		if (!isZodNode(node) || seen.has(node)) continue
		seen.add(node)
		const { def } = node
		if (def.type === "pipe" || def.type === "transform") return true
		/* a lazy holds its schema behind a function, called once, as a recursive schema meets itself again */
		if (def.type === "lazy") pending.push((def as unknown as { getter: () => unknown }).getter())
		for (const entry of Object.values(def)) pending.push(...heldBy(entry))
	}
	return false
}

/**
 * A c.json column's schema is the stored document: the write DTOs store its output and the read DTO
 * parses the stored row with it (CD2 of r22b), so one whose output its input refuses is an error
 * naming the column; and a NOT NULL column of one value refuses a schema that takes null, whose
 * write DTO would take a body the insert fails (CD3, the sibling of r19 C5), as does one that takes
 * undefined where no default fills the column, a body that leaves the field out (AA4 of area A's
 * review). `notNull` is false for a Postgres array of documents, which holds null elements whatever
 * the column's own NOT NULL; `filled` says a default fills the column
 */
function refuseJsonDocument(
	schema: unknown,
	at: string,
	{ filled, notNull }: { filled: boolean; notNull: boolean },
): void {
	if (changesValue(schema))
		throw new Error(
			`${at}: a c.json schema is the stored document; its transform's output is what gets stored, and the read DTO could not parse it. Move the transform to the request body's schema.`,
		)
	const takes = (value: unknown) =>
		(schema as { safeParse(value: unknown): { success: boolean } }).safeParse(value).success
	if (notNull && takes(null))
		throw new Error(
			`${at}: its schema takes null and the column is NOT NULL: make the column nullable, or pass the schema's non-null form`,
		)
	if (notNull && !filled && takes(undefined))
		throw new Error(
			`${at}: its schema takes undefined (an .optional(), a .default() or a union with undefined) and the column is NOT NULL with no default: make the schema refuse undefined, or give the column a default`,
		)
}

export { constraintsOf, refuseJsonDocument, statesOf, STRING_LIST }
