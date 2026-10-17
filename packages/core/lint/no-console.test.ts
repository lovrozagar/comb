import { describe, expect, it } from "vitest"
import plugin from "./index.js"
import { oxlintReports, reportsOf } from "./rule-harness.ts"

const rule = plugin.rules["no-console"]
const MESSAGE = "console belongs to src/log.ts, src/cli/output.ts and src/bin.ts; write through the injected sink"

describe("comb/no-console", () => {
	it("rejects console in core source", () => {
		const fixture = {
			"packages/core/src/cli.ts": 'console.log("x")\n',
			"packages/core/src/migrate/core/utils.ts": 'export const f = () => console["warn"]("x")\n',
			"packages/core/src/codegen/generators/dtos/generate.ts": "export const out = console.error\n",
		}
		expect(reportsOf(rule, fixture)).toEqual([
			{ file: "packages/core/src/cli.ts", message: MESSAGE },
			{ file: "packages/core/src/migrate/core/utils.ts", message: MESSAGE },
			{ file: "packages/core/src/codegen/generators/dtos/generate.ts", message: MESSAGE },
		])
	})

	it("allows the two sinks, the bin shim, tests, and code outside src", () => {
		const fixture = {
			"packages/core/src/log.ts": 'export const log = () => console.info("x")\n',
			"packages/core/src/bin.ts": "process.exitCode = await runCli(argv, { err: (l) => console.error(l) })\n",
			"packages/core/src/cli/output.ts": 'export const out = () => console.log("x")\n',
			"packages/core/src/query/filter.test.ts": 'console.log("x")\n',
			"packages/core/tests/integration/d1/smoke.test.ts": 'console.log("x")\n',
			"scripts/verify.ts": 'console.table("x")\n',
			"packages/core/src/query/filter.ts": "const logger = { console: 1 }\nexport const n = logger.console\n",
		}
		expect(reportsOf(rule, fixture)).toEqual([])
	})

	it("fails oxlint through the comb plugin entry", () => {
		const fixture = {
			"packages/core/src/cli.ts": 'console.log("x")\n',
			"packages/core/src/log.ts": 'console.log("x")\n',
		}
		expect(oxlintReports("no-console", fixture)).toEqual([{ file: "packages/core/src/cli.ts", message: MESSAGE }])
	})
})
