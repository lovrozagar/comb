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

/** A c.enum column's state machine as JSON; an error naming the column for one of another shape */
function statesOf(raw: unknown, at: string): SnapshotComb["states"] {
	if (raw === undefined) return null
	/* a misspelt key would leave its part of the machine unread (F9) */
	const unknown = Object.keys(raw as object).find((key) => !STATE_KEYS.includes(key))
	if (unknown !== undefined)
		throw new Error(
			`${at}: its state machine has ${unknown}, which is none of initial, terminal, transitions and values`,
		)
	const { initial, terminal, transitions } = raw as Record<string, unknown>
	const map = transitions as Record<string, unknown> | undefined
	const valid =
		(initial === undefined || typeof initial === "string") &&
		(terminal === undefined || STRING_LIST(terminal)) &&
		(map === undefined || Object.values(map).every(STRING_LIST))
	if (!valid) throw new Error(`${at}: its state machine is not { initial?, terminal?, transitions? } of state names`)
	return {
		initial: (initial as string | undefined) ?? null,
		terminal: (terminal as string[] | undefined) ?? null,
		transitions: (map as Record<string, string[]> | undefined) ?? null,
	}
}

export { constraintsOf, statesOf, STRING_LIST }
