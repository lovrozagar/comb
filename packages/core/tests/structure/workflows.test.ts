/**
 * Every GitHub Action the workflows run is pinned to a full commit SHA, with the release it
 * names in a trailing comment. A tag can be moved to other code; a SHA cannot.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const WORKFLOWS = join(import.meta.dirname, "../../../../.github/workflows")

const USES = /^\s*-?\s*uses:\s*(\S+)(.*)$/

/** Each `uses:` in `yaml` that is not `owner/repo@<40-hex sha> # vX.Y.Z` (local and docker actions aside). */
export function unpinned(yaml: string): string[] {
	return yaml
		.split("\n")
		.map((line) => USES.exec(line))
		.filter((match): match is RegExpExecArray => match !== null)
		.filter(([, action]) => !action!.startsWith("./") && !action!.startsWith("docker://"))
		.filter(([, action, rest]) => !/@[0-9a-f]{40}$/.test(action!) || !/^\s+#\s*v\d+\.\d+\.\d+\s*$/.test(rest!))
		.map(([, action]) => action!)
}

/** Each line in `yaml` that pipes a download straight into a shell: code nothing pins or checks */
export function pipedToShell(yaml: string): string[] {
	return yaml
		.split("\n")
		.filter((line) => /\b(?:curl|wget)\b[^|#]*\|\s*(?:sudo\s+)?(?:[\w=-]+=\S*\s+)*(?:ba|z)?sh\b/.test(line))
		.map((line) => line.trim())
}

describe("workflow downloads", () => {
	it("no workflow pipes a download into a shell; binaries are fetched by version and checked against a pinned sha256", () => {
		const files = readdirSync(WORKFLOWS).filter((name) => /\.ya?ml$/.test(name))
		const piped = files.flatMap((name) =>
			pipedToShell(readFileSync(join(WORKFLOWS, name), "utf8")).map((line) => `${name}: ${line}`),
		)
		expect(piped).toEqual([])
	})

	it.each([
		["        run: curl -sSf https://atlasgo.sh | ATLAS_VERSION=v1.3.0 CI=true sh", 1],
		["        run: curl -fsSL https://x.sh | bash", 1],
		["        run: wget -qO- https://x.sh | sudo sh", 1],
		['        run: curl -sSfL -o "$RUNNER_TEMP/atlas" https://release.ariga.io/atlas/atlas-linux-amd64-v1.3.0', 0],
		["        run: echo abc | sha256sum -c -", 0],
	])("the checker: %s", (line, hits) => {
		expect(pipedToShell(line)).toHaveLength(hits)
	})
})

/** The permissions block at the top of a workflow, before `jobs:` (every job inherits it) */
function workflowPermissions(yaml: string): string {
	const top = yaml.slice(0, yaml.search(/^jobs:/m))
	return /^permissions:\n((?:[ \t]+.*\n)*)/m.exec(top)?.[1] ?? ""
}

describe("workflow permissions", () => {
	it("grant nothing beyond contents: read to every job; a job that publishes asks for more itself", () => {
		for (const name of readdirSync(WORKFLOWS).filter((file) => /\.ya?ml$/.test(file))) {
			const granted = workflowPermissions(readFileSync(join(WORKFLOWS, name), "utf8"))
			expect(granted.trim().split("\n").filter(Boolean), name).toEqual(granted.trim() === "" ? [] : ["contents: read"])
		}
	})
})

describe("workflow actions", () => {
	it("every workflow pins every action to a commit SHA", () => {
		const files = readdirSync(WORKFLOWS).filter((name) => /\.ya?ml$/.test(name))
		expect(files.length).toBeGreaterThan(0)
		const loose = files.flatMap((name) =>
			unpinned(readFileSync(join(WORKFLOWS, name), "utf8")).map((action) => `${name}: ${action}`),
		)
		expect(loose).toEqual([])
	})

	it.each([
		["      - uses: actions/checkout@v4", ["actions/checkout@v4"]],
		["      - uses: actions/checkout@latest", ["actions/checkout@latest"]],
		[
			"      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
			["actions/checkout@11d5960a326750d5838078e36cf38b85af677262"],
		],
		["      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0", []],
		["        uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0", []],
		["      - uses: ./.github/actions/local", []],
		["      - run: echo uses: actions/checkout@v4", []],
	])("the checker: %s", (yaml, expected) => {
		expect(unpinned(yaml)).toEqual(expected)
	})
})
