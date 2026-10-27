import { describe, expect, it } from "vitest"
import { readInspect, refuseUnclean } from "./atlas-clean.ts"
import type { Run, RunResult } from "./process.ts"

const TARGET = { devUrl: "", lockTimeout: "5s", schema: "app", url: "postgres://app:S3cret@db/app" }
const BASELINE =
	"the database has objects but no migration history, and no shared history row matches this directory's files (a database made by hand, or another directory's history); if its schema matches the migrations, record them with comb migrate baseline"

/** Atlas answering every call with `answer`, recording the arguments and the URL it was given */
function atlas(answer: RunResult) {
	const calls: Array<{ args: readonly string[]; url: string | undefined }> = []
	const exec: Run = (_cmd, args, options) => {
		calls.push({ args, url: options?.env?.["COMB_ATLAS_URL"] })
		return answer
	}
	return { calls, exec }
}
const inspected = (body: unknown): RunResult => ({ code: 0, stderr: "", stdout: JSON.stringify(body) })

describe("refuseUnclean", () => {
	it("passes a schema with no table, or one whose views and functions Atlas does not inspect", () => {
		for (const body of [{}, { schemas: [{ name: "app" }] }, { schemas: [{ name: "app", tables: [] }] }]) {
			const fake = atlas(inspected(body))
			expect(() => refuseUnclean({ exec: fake.exec, target: TARGET })).not.toThrow()
			expect(fake.calls[0]?.args.slice(0, 6)).toEqual([
				"schema",
				"inspect",
				"--url",
				"env://url",
				"--format",
				"{{ json . }}",
			])
			expect(fake.calls[0]?.url).toContain("search_path=app")
		}
	})

	it("refuses a schema holding a table with apply's baseline message", () => {
		const fake = atlas(inspected({ schemas: [{ name: "app", tables: [{ name: "legacy" }] }] }))
		expect(() => refuseUnclean({ exec: fake.exec, target: TARGET })).toThrow(BASELINE)
	})

	/* M79: Atlas's inspect of a table with a primary key, read as Atlas wrote it */
	it("refuses a schema whose table has a primary key and a token column with the baseline message, not a parse error", () => {
		const table = { columns: [{ name: "api_token" }], name: "t", primary_key: { parts: [{ column: "id" }] } }
		const fake = atlas(inspected({ schemas: [{ name: "app", tables: [table] }] }))
		expect(() => refuseUnclean({ exec: fake.exec, target: TARGET })).toThrow(BASELINE)
	})

	/* M79: parsed as Atlas wrote it and never scrubbed, so a password that spells a key changes nothing it reads */
	it("reads Atlas's JSON as written, so a password that spells a key changes nothing it reads", () => {
		const keyword = { ...TARGET, url: "postgres://app:tables@db/app" }
		const table = atlas(inspected({ schemas: [{ name: "app", tables: [{ name: "tables" }] }] }))
		expect(() => refuseUnclean({ exec: table.exec, target: keyword })).toThrow(BASELINE)
		expect(() => readInspect("{ S3cret")).toThrow(/^unexpected output from atlas schema inspect$/)
	})

	it("says what Atlas said when the inspect fails, scrubbed of the password", () => {
		const fake = atlas({ code: 1, stderr: "Error: dial postgres://app:S3cret@db/app: refused", stdout: "" })
		const thrown = (() => {
			try {
				refuseUnclean({ exec: fake.exec, target: TARGET })
			} catch (error) {
				return (error as Error).message
			}
		})()
		expect(thrown).toMatch(/^atlas schema inspect: Error: dial /)
		expect(thrown).not.toContain("S3cret")
	})
})
