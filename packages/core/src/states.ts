/**
 * Column state machines — legal values, legal transitions, and which values are
 * final.
 *
 * A comb concept first: `assertTransition` is a write-side guard an application
 * calls at the boundary that cares. The meta contract publishes a subset of the
 * same declaration (§5 of docs/state-machines.md), but nothing here is shaped
 * around a consumer's predicate syntax.
 */
import { CombError } from "./error.ts"
import { combErrorKeys } from "./types.ts"

/**
 * A declared machine over a column's values.
 *
 * Every field beyond `values` is optional and independently useful: declaring
 * only `terminal` already says which states are final, which is the cheap half
 * most schemas want; `transitions` is what earns the runtime guard.
 */
type StateMachine<TState extends string = string> = {
	/** Every legal value, in declaration order */
	values: readonly TState[]
	/** The value a row starts at, when there is exactly one */
	initial?: TState | undefined
	/** Values from which no transition is legal */
	terminal?: readonly TState[] | undefined
	/** Legal moves, `from` → `to[]`. Omitted states are unconstrained. */
	transitions?: Readonly<Partial<Record<TState, readonly TState[]>>> | undefined
}

/**
 * Declare a machine with its states inferred from `values` alone.
 *
 * `{ … } as const satisfies StateMachine` checks every name against `string`, so a misspelled
 * `transitions` key or target compiles and the rule it meant silently disappears. Here every other
 * field may only name a declared value, and a typo is a type error.
 */
function defineStateMachine<const TState extends string>(machine: {
	values: readonly TState[]
	initial?: NoInfer<TState> | undefined
	terminal?: readonly NoInfer<TState>[] | undefined
	transitions?: Readonly<Partial<Record<NoInfer<TState>, readonly NoInfer<TState>[]>>> | undefined
}): StateMachine<TState> {
	return machine
}

/** Whether a value is one the machine declares. */
function isState<T extends string>(machine: StateMachine<T>, value: unknown): value is T {
	return typeof value === "string" && (machine.values as readonly string[]).includes(value)
}

/** The moves a machine declares out of `from`; undefined when it declares none (an inherited name is none). */
function movesFrom<T extends string>(machine: StateMachine<T>, from: T): readonly T[] | undefined {
	const transitions = machine.transitions
	return transitions !== undefined && Object.hasOwn(transitions, from) ? transitions[from] : undefined
}

/** Whether no transition may leave this state. */
function isTerminal<T extends string>(machine: StateMachine<T>, state: T): boolean {
	return machine.terminal?.includes(state) ?? false
}

/**
 * Whether `from → to` is legal.
 *
 * A machine that declares no `transitions` constrains nothing except that a
 * terminal state cannot be left — which is the cheap half doing useful work on
 * its own. A state absent from a declared `transitions` map is likewise
 * unconstrained: that is how a schema declares only the part it knows.
 */
function canTransition<T extends string>(machine: StateMachine<T>, from: T, to: T): boolean {
	if (!isState(machine, from) || !isState(machine, to)) return false
	/* Staying put is not a transition, including from a terminal state. */
	if (from === to) return true
	if (isTerminal(machine, from)) return false

	const allowed = movesFrom(machine, from)
	if (allowed === undefined) return true
	return allowed.includes(to)
}

/**
 * Throw unless `from → to` is legal.
 *
 * Raises `CombError` with `invalid_state_transition` at 422, the same shape
 * every other comb-detected violation takes, so an HTTP layer needs no special
 * case for it.
 *
 * Deliberately explicit rather than an ORM hook: comb does not own the write
 * path, and a backfill or a correction may legitimately need to move a row in a
 * way the product rules forbid. A rule you cannot see at the call site and
 * cannot opt out of is worse than one you must remember to call.
 */
function assertTransition<T extends string>(machine: StateMachine<T>, from: T, to: T, column = "status"): void {
	if (canTransition(machine, from, to)) return

	const reason = !isState(machine, to)
		? `"${String(to)}" is not a declared state`
		: !isState(machine, from)
			? `"${String(from)}" is not a declared state`
			: isTerminal(machine, from)
				? `"${String(from)}" is terminal`
				: `"${String(from)}" does not lead to "${String(to)}"`

	throw new CombError({
		cause: `${column}: ${reason}`,
		column,
		errorKey: combErrorKeys.INVALID_STATE_TRANSITION,
		status: "unprocessable_entity",
	})
}

/** States reachable in one move, empty for a terminal or unknown state. */
function nextStates<T extends string>(machine: StateMachine<T>, from: T): readonly T[] {
	if (!isState(machine, from) || isTerminal(machine, from)) return []
	const moves = movesFrom(machine, from) ?? machine.values.filter((v) => v !== from)
	return moves.filter((to) => isState(machine, to))
}

export { assertTransition, canTransition, defineStateMachine, isState, isTerminal, nextStates, type StateMachine }
