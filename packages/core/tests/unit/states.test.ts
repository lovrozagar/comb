import { describe, expect, it } from "vitest"
import { CombError } from "../../src/error.ts"
import {
	assertTransition,
	canTransition,
	isState,
	isTerminal,
	nextStates,
	type StateMachine,
} from "../../src/states.ts"
import { combErrorKeys } from "../../src/types.ts"

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

describe("assertTransition", () => {
	it("is silent on a legal move", () => {
		expect(() => assertTransition(delivery, "queued", "sending")).not.toThrow()
		expect(() => assertTransition(delivery, "sent", "sent")).not.toThrow()
	})

	it("raises CombError 422 with invalid_state_transition", () => {
		expect(() => assertTransition(delivery, "sent", "queued")).toThrow(CombError)
		try {
			assertTransition(delivery, "sent", "queued", "status")
			expect.unreachable()
		} catch (error) {
			expect(error).toBeInstanceOf(CombError)
			const err = error as CombError
			expect(err.errorKey).toBe(combErrorKeys.INVALID_STATE_TRANSITION)
			expect(err.status).toBe(422)
			expect(err.statusKey).toBe("unprocessable_entity")
			expect(err.column).toBe("status")
			expect(err.cause).toContain("terminal")
		}
	})

	it("names an unknown target, an unknown source, and a missing edge", () => {
		try {
			assertTransition(delivery, "queued", "done")
			expect.unreachable()
		} catch (error) {
			expect((error as CombError).cause).toContain("not a declared state")
		}
		try {
			assertTransition(delivery, "done", "queued")
			expect.unreachable()
		} catch (error) {
			expect((error as CombError).cause).toContain("not a declared state")
		}
		try {
			assertTransition(delivery, "queued", "sent")
			expect.unreachable()
		} catch (error) {
			expect((error as CombError).cause).toContain("does not lead")
		}
	})
})
