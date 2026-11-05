/**
 * The release workflow creates the GitHub release only once every publish it needs succeeded, so no
 * release names a version a registry lacks. An `if:` on the job replaces the default `success()`, so
 * it must check each needed job's result itself.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const RELEASE = join(import.meta.dirname, "../../../../.github/workflows/release.yml")

/** A job's `needs` and its `if:` expression, read from its block of `yaml` */
export function jobGate(yaml: string, job: string): { condition: string | undefined; needs: string[] } {
	const start = yaml.search(new RegExp(`^ {2}${job}:$`, "m"))
	if (start === -1) throw new Error(`no job ${job}`)
	const rest = yaml.slice(start + 1)
	const end = rest.search(/^ {2}[\w-]+:$/m)
	const block = end === -1 ? rest : rest.slice(0, end)
	const needs =
		/^ {4}needs:\s*\[([^\]]*)\]$/m
			.exec(block)?.[1]
			?.split(",")
			.map((name) => name.trim()) ?? []
	const condition = /^ {4}if:\s*(.+?)\s*$/m.exec(block)?.[1]
	return { condition, needs }
}

/** The jobs `needs` lists whose success `condition` does not require: all of them when it replaces success() unchecked */
export function unchecked({ condition, needs }: ReturnType<typeof jobGate>): string[] {
	if (condition === undefined) return []
	return needs.filter((need) => !condition.includes(`needs.${need}.result == 'success'`))
}

describe("the GitHub release", () => {
	it("is created only when every publish job it needs succeeded", () => {
		const gate = jobGate(readFileSync(RELEASE, "utf8"), "github-release")
		expect(gate.needs).toEqual(["npmjs", "gh-pkg"])
		expect(unchecked(gate)).toEqual([])
	})

	it("reads a job's gate, and counts a need its if: leaves unchecked", () => {
		const yaml =
			"jobs:\n  a:\n    run: x\n  r:\n    needs: [a, b]\n    if: ${{ needs.b.result == 'success' }}\n  z:\n    run: y\n"
		expect(jobGate(yaml, "r")).toEqual({ condition: "${{ needs.b.result == 'success' }}", needs: ["a", "b"] })
		expect(unchecked(jobGate(yaml, "r"))).toEqual(["a"])
		expect(unchecked({ condition: undefined, needs: ["a"] })).toEqual([])
		expect(jobGate(yaml, "a")).toEqual({ condition: undefined, needs: [] })
		expect(() => jobGate(yaml, "q")).toThrow("no job q")
	})
})
