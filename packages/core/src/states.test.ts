import { describe, expect, it } from "vitest"
import { CombError } from "./error.ts"
import {
	assertTransition,
	canTransition,
	defineStateMachine,
	isState,
	isTerminal,
	nextStates,
	type StateMachine,
} from "./states.ts"
import { combErrorKeys } from "./types.ts"

const delivery = {
	initial: "queued",
	terminal: ["sent", "partial", "failed", "cancelled"],
	transitions: {
		queued: ["sending", "cancelled"],
		sending: ["sent", "partial", "failed"],
	},
	values: ["queued", "sending", "sent", "partial", "failed", "cancelled"],
} as const satisfies StateMachine

/** Cheap half: terminal vs not, no graph. */
const terminalOnly = {
	terminal: ["complete", "failed"],
	values: ["processing", "complete", "failed"],
} as const satisfies StateMachine

describe("isState", () => {
	it("accepts a declared value and rejects everything else", () => {
		expect(isState(delivery, "queued")).toBe(true)
		expect(isState(delivery, "sent")).toBe(true)
		expect(isState(delivery, "done")).toBe(false)
		expect(isState(delivery, 1)).toBe(false)
		expect(isState(delivery, null)).toBe(false)
	})
})

describe("isTerminal", () => {
	it("is true only for values listed in terminal", () => {
		expect(isTerminal(delivery, "sent")).toBe(true)
		expect(isTerminal(delivery, "queued")).toBe(false)
	})

	it("is false for every value when terminal is omitted", () => {
		const open: StateMachine = { values: ["a", "b"] }
		expect(isTerminal(open, "a")).toBe(false)
	})
})

describe("canTransition", () => {
	it("allows a declared edge and rejects an undeclared one", () => {
		expect(canTransition(delivery, "queued", "sending")).toBe(true)
		expect(canTransition(delivery, "queued", "sent")).toBe(false)
		expect(canTransition(delivery, "sending", "queued")).toBe(false)
	})

	it("rejects leaving a terminal state, but staying put is not a transition", () => {
		expect(canTransition(delivery, "sent", "queued")).toBe(false)
		expect(canTransition(delivery, "sent", "sent")).toBe(true)
		expect(canTransition(delivery, "queued", "queued")).toBe(true)
	})

	it("rejects values the machine does not declare", () => {
		expect(canTransition(delivery, "queued", "done")).toBe(false)
		expect(canTransition(delivery, "done", "queued")).toBe(false)
	})

	it("with no transitions map, only terminal-vs-not constrains the move", () => {
		expect(canTransition(terminalOnly, "processing", "complete")).toBe(true)
		expect(canTransition(terminalOnly, "processing", "failed")).toBe(true)
		expect(canTransition(terminalOnly, "complete", "processing")).toBe(false)
		expect(canTransition(terminalOnly, "complete", "failed")).toBe(false)
	})

	it("treats a state absent from a partial transitions map as unconstrained", () => {
		const partial: StateMachine = {
			transitions: { draft: ["review"] },
			values: ["draft", "review", "live"],
		}
		expect(canTransition(partial, "review", "live")).toBe(true)
		expect(canTransition(partial, "draft", "live")).toBe(false)
	})
})

describe("nextStates", () => {
	it("returns the declared outgoing set, empty for a terminal or unknown state", () => {
		expect(nextStates(delivery, "queued")).toEqual(["sending", "cancelled"])
		expect(nextStates(delivery, "sent")).toEqual([])
		expect(nextStates(delivery, "nope" as (typeof delivery.values)[number])).toEqual([])
	})

	it("falls back to every other value when the map does not name the state", () => {
		expect(nextStates(terminalOnly, "processing")).toEqual(["complete", "failed"])
	})
})

/** The CombError `run` throws; fails the test when it throws nothing or something else */
function combErrorOf(run: () => void): CombError {
	try {
		run()
	} catch (error) {
		if (error instanceof CombError) return error
		throw error
	}
	throw new Error("expected a CombError, nothing was thrown")
}

describe("assertTransition", () => {
	it("is silent on a legal move", () => {
		expect(() => assertTransition(delivery, "queued", "sending")).not.toThrow()
		expect(() => assertTransition(delivery, "sent", "sent")).not.toThrow()
	})

	it("raises CombError 422 with invalid_state_transition, on the status column by default", () => {
		const err = combErrorOf(() => assertTransition(delivery, "sent", "queued"))
		expect(err.errorKey).toBe(combErrorKeys.INVALID_STATE_TRANSITION)
		expect(err.status).toBe(422)
		expect(err.statusKey).toBe("unprocessable_entity")
		expect(err.column).toBe("status")
		expect(err.cause).toBe('status: "sent" is terminal')
	})

	it("names the column the machine declares", () => {
		const phase = defineStateMachine({ column: "phase", terminal: ["done"], values: ["open", "done"] })
		const err = combErrorOf(() => assertTransition(phase, "done", "open"))
		expect(err.column).toBe("phase")
		expect(err.cause).toBe('phase: "done" is terminal')
	})

	it("names an unknown target, an unknown source, and a missing edge", () => {
		expect(combErrorOf(() => assertTransition(delivery, "queued", "done" as never)).cause).toContain(
			"not a declared state",
		)
		expect(combErrorOf(() => assertTransition(delivery, "done" as never, "queued")).cause).toContain(
			"not a declared state",
		)
		expect(combErrorOf(() => assertTransition(delivery, "queued", "sent")).cause).toContain("does not lead")
	})

	it("passes on an error that is not its own", () => {
		expect(() =>
			combErrorOf(() => {
				throw new TypeError("x")
			}),
		).toThrow(TypeError)
		expect(() => combErrorOf(() => undefined)).toThrow("nothing was thrown")
	})
})

describe("state names that are also Object.prototype members (M-L1)", () => {
	const machine: StateMachine = {
		terminal: ["done"],
		transitions: { open: ["done"] },
		values: ["open", "constructor", "toString", "done"],
	}

	it("treat them as ordinary states", () => {
		expect(canTransition(machine, "constructor", "done")).toBe(true)
		expect(canTransition(machine, "toString", "open")).toBe(true)
		expect(() => assertTransition(machine, "constructor", "done")).not.toThrow()
		expect(nextStates(machine, "constructor")).toEqual(["open", "toString", "done"])
	})

	it("reject them when the machine does not declare them", () => {
		const plain: StateMachine = { transitions: { a: ["b"] }, values: ["a", "b"] }
		expect(canTransition(plain, "constructor" as never, "a")).toBe(false)
		expect(() => assertTransition(plain, "constructor" as never, "a")).toThrow(CombError)
		expect(nextStates(plain, "valueOf" as never)).toEqual([])
	})
})

describe("nextStates (M-L2)", () => {
	it("lists only declared targets", () => {
		const machine = { transitions: { a: ["b", "zzz"] }, values: ["a", "b"] } as StateMachine
		expect(nextStates(machine, "a")).toEqual(["b"])
	})
})

describe("defineStateMachine (M5)", () => {
	it("infers the states from values, so a misspelled name fails to compile", () => {
		const machine = defineStateMachine({
			terminal: ["sent"],
			transitions: { queued: ["sent"] },
			values: ["queued", "sent"],
		})
		expect(canTransition(machine, "queued", "sent")).toBe(true)

		// @ts-expect-error a transitions key that is not a declared value
		defineStateMachine({ transitions: { queud: ["sent"] }, values: ["queued", "sent"] })
		// @ts-expect-error a transitions target that is not a declared value
		defineStateMachine({ transitions: { queued: ["snet"] }, values: ["queued", "sent"] })
		// @ts-expect-error a terminal name that is not a declared value
		defineStateMachine({ terminal: ["dotypo"], values: ["queued", "sent"] })
		// @ts-expect-error an initial name that is not a declared value
		defineStateMachine({ initial: "queud", values: ["queued", "sent"] })
	})
})
