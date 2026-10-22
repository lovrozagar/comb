import { afterEach, describe, expect, it } from "vitest"
import { oxlintJson, oxlintReports, reportsOf } from "./rule-harness.ts"
import { children } from "./scope.js"

/** A rule that reports the comments the harness says touch every `debugger` statement. */
const commentRule = {
	create(context: Parameters<Parameters<typeof reportsOf>[0]["create"]>[0]) {
		return {
			DebuggerStatement(node: never) {
				const before = context.sourceCode.getCommentsBefore(node).map((c) => `before:${c.value.trim()}`)
				const after = context.sourceCode.getCommentsAfter(node).map((c) => `after:${c.value.trim()}`)
				for (const message of [...before, ...after]) context.report({ message, node })
			},
		}
	},
}

describe("reportsOf", () => {
	it("hands a rule only the comments that touch a node, as ESLint's SourceCode does", () => {
		const code = "// far\nlet x = 1\n// near\ndebugger // tail\nx = 2 // later\n"
		expect(reportsOf(commentRule, { "a.ts": code }).map((r) => r.message)).toEqual(["before:near", "after:tail"])
	})
})

describe("oxlintReports", () => {
	const tmp = process.env["TMPDIR"]
	afterEach(() => {
		if (tmp === undefined) delete process.env["TMPDIR"]
		else process.env["TMPDIR"] = tmp
	})

	it("returns the real binary's findings sorted by fixture path", () => {
		const fixture = {
			"packages/core/src/query/z.ts": "console.log(1)\n",
			"packages/core/src/query/a.ts": "console.log(1)\n",
		}
		expect(oxlintReports("no-console", fixture).map((r) => r.file)).toEqual([
			"packages/core/src/query/a.ts",
			"packages/core/src/query/z.ts",
		])
	})

	it("refuses a TMPDIR inside a git checkout, where oxlint would lint nothing", () => {
		process.env["TMPDIR"] = import.meta.dirname
		expect(() => oxlintReports("no-console", {})).toThrow("is inside a git checkout")
	})
})

describe("oxlintJson", () => {
	const killed = { error: undefined, signal: "SIGKILL" as const, status: null, stderr: "", stdout: "" }

	it("reads the report oxlint printed", () => {
		expect(oxlintJson({ ...killed, signal: null, status: 1, stdout: '{"diagnostics":[]}' })).toEqual({
			diagnostics: [],
		})
	})

	/* a child killed under memory pressure leaves no output at all; the failure must say how it ended */
	it("names how a child that printed no report ended: its signal, exit, spawn error and stderr", () => {
		expect(() => oxlintJson(killed)).toThrow("oxlint printed no JSON report (exit null, signal SIGKILL): no stderr")
		expect(() => oxlintJson({ ...killed, signal: null, status: 1, stderr: "failed to load plugin\n" })).toThrow(
			"oxlint printed no JSON report (exit 1, signal none): failed to load plugin",
		)
		const error = Object.assign(new Error("spawnSync oxlint EAGAIN"), { code: "EAGAIN" })
		/* a child that never started has neither stream, as node:child_process returns it */
		const unstarted = { error, signal: null, status: null, stderr: undefined, stdout: undefined }
		expect(() => oxlintJson(unstarted as unknown as typeof killed)).toThrow(
			"oxlint printed no JSON report (exit null, signal none, spawnSync oxlint EAGAIN): no stderr",
		)
	})
})

describe("children", () => {
	it("lists the child nodes, never the parent link back up", () => {
		const parent = { type: "Program" }
		const leaf = { type: "Identifier" }
		const node = { left: leaf, list: [leaf, null, 1], parent, type: "BinaryExpression" }
		expect(children(node)).toEqual([leaf, leaf])
	})
})
