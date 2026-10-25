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
		constraints[key] = value
	}
	return constraints
}

/** A c.enum column's state machine as JSON; an error naming the column for one of another shape */
function statesOf(raw: unknown, at: string): SnapshotComb["states"] {
	if (raw === undefined) return null
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
