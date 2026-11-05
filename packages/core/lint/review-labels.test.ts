import { describe, expect, it } from "vitest"
import { reviewLabels } from "./review-labels.js"

describe("reviewLabels on a qualified label", () => {
	it("finds every form a comment cites a finding in", () => {
		const text = [
			"the cap (KC2 of r22b); CD7, CS4 and CS6 of r22b; Q14 of r17, R2 of plan 16's review",
			"S6 of the 0.15.0 review, B2-3 of area B, X1 of area C round 2, Y2 of the area D round-three review",
			"Z3 of the round-three review, W4 of plan 21's rerun, V5 of phase 9, T6 of the 0.16.0 consumers review",
			"0.20.0 G3 and AB4-7, (U22), (F50, AA3)",
			"HN1 of plan 21: led here",
			"HN2: leads",
			"R1 of 5.3 and P9 of 0.15.0, 27.12 and 27.18 of plan 15, the sibling of r19 C5, AA10's class",
			"(N-S5), N-S6 of plan 15's rerun, R2 of 5.3's review",
		].join("\n")
		expect(reviewLabels(text)).toEqual([
			"KC2 of r22b",
			"CD7, CS4 and CS6 of r22b",
			"Q14 of r17",
			"R2 of plan 16's review",
			"S6 of the 0.15.0 review",
			"B2-3 of area B",
			"X1 of area C round 2",
			"Y2 of the area D round-three review",
			"Z3 of the round-three review",
			"W4 of plan 21's rerun",
			"V5 of phase 9",
			"T6 of the 0.16.0 consumers review",
			"0.20.0 G3",
			"AB4-7",
			"U22",
			"F50",
			"AA3",
			"HN1 of plan 21",
			"HN2",
			"R1 of 5.3",
			"P9 of 0.15.0",
			"27.12 and 27.18 of plan 15",
			"r19 C5",
			"AA10",
			"N-S5",
			"N-S6 of plan 15's rerun",
			"R2 of 5.3's review",
		])
	})
})

describe("reviewLabels beyond a qualified label", () => {
	it("takes any finding-shaped ID that is no real name as a label, wherever it stands", () => {
		expect(
			reviewLabels(
				"so the F20 check knows; C21; AE1 to AE5; inspected as a check does (G1-a); a command M70 warns of; its domain (P3)",
			),
		).toEqual(["F20", "C21", "AE1", "AE5", "G1", "M70", "P3"])
	})

	it("takes a plan's step, a probe, a round and a scratch log as labels", () => {
		expect(
			reviewLabels(
				"refused (5.3); read (27.17, 8.4b); plan 14's 5.4b; 0005 of r22b; never unsaid (r22b); (.tmp/grunt/r21/p1.log)",
			),
		).toEqual(["5.3", "27.17", "8.4b", "plan 14's 5.4b", "0005 of r22b", "r22b", ".tmp/grunt/r21/p1.log"])
	})

	it("follows a label across a comment's line break", () => {
		expect(reviewLabels("kept (KT7 of\n * r22b)")).toEqual(["KT7 of r22b"])
		expect(reviewLabels("kept KT7 of\n// r22b")).toEqual(["KT7 of r22b"])
	})

	it("leaves real names and prose alone", () => {
		expect(reviewLabels("D1, FTS5, RE2, SHA256, ES2022, UTF8, INT4, TS2306, (P0001), (XX000)")).toEqual([])
		expect(
			reviewLabels(
				"meta-contract §8.2; TypeScript 5.4 and 5.7; version 0.12; durations (1500ms, 1.5s, 1min); D1's and RE2's rules; 2.5 of them",
			),
		).toEqual([])
		expect(
			reviewLabels(
				"an opcode whose P1 is a cursor, whose P2 is a register, and P5 its flags; the cursor P1; FLAG_P2ISREG; U+0000; IPv4",
			),
		).toEqual([])
	})
})
