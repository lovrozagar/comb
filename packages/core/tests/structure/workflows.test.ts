/**
 * Every GitHub Action the workflows run is pinned to a full commit SHA, with the release it
 * names in a trailing comment. A tag can be moved to other code; a SHA cannot. And CI runs the
 * gates `bun run verify` runs, no more and no fewer, so a stamp vouches for what CI checks.
 */
import { execFileSync } from "node:child_process"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { DATE_KEYS, OFF_UTC_INTEGRATION, OFF_UTC_UNIT, OFF_UTC_ZONE } from "../support/off-utc.ts"

const ROOT = join(import.meta.dirname, "../../../..")
const WORKFLOWS = join(ROOT, ".github/workflows")

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

/**
 * One CI step as ci.yml lists it: a one-line `run:` by its command, a `run: |` block by its step's
 * name. A step's `bun run [--filter <package>] <script>` names the script it runs.
 */
export function ciSteps(yaml: string): Array<{ command?: string; name?: string }> {
	const steps: Array<{ command?: string; name?: string }> = []
	let name: string | undefined
	for (const line of yaml.split("\n")) {
		const named = /^\s+- name:\s*(.+?)\s*$/.exec(line)
		if (named !== null) name = named[1]
		const run = /^\s+(-\s+)?run:\s*(.*?)\s*$/.exec(line)
		if (run === null) continue
		steps.push(run[2] === "|" ? { name } : { command: run[2] })
		name = undefined
	}
	return steps
}

/** The gates `bun run verify` runs, in its order: verify's own gates() over package.json's standards.gates */
function verifyGates(): string[] {
	const script =
		'const { gates } = await import("./scripts/verify.ts"); const pkg = await Bun.file("package.json").json(); console.log(JSON.stringify(gates(pkg.standards.gates).map((g) => g.name)))'
	return JSON.parse(execFileSync("bun", ["-e", script], { cwd: ROOT, encoding: "utf8" })) as string[]
}

/** The script a `bun run` step runs, through comb's package filter or the root */
const scriptOf = (command: string) => /^bun run (?:--filter \S+ )?(\S+)$/.exec(command)?.[1]

/* the CI steps no local gate stands for: installs, the commit-message lint lefthook's commit-msg
   hook runs, the release dry run, and the Atlas binary the test jobs fetch */
const SETUP = {
	commands: ["bun install --frozen-lockfile", "npm install -g npm@latest"],
	names: ["Lint commit messages", "dry-run the release publish", "install atlas v1.3.0"],
}

describe("ci.yml and verify run the same gates", () => {
	/* the 0.13 RC: CI ran test:coverage and verify ran test, so a stamp passed what CI failed */
	it("every bun run step in CI is a verify gate, every verify gate a CI step, and every other step setup", () => {
		const steps = ciSteps(readFileSync(join(WORKFLOWS, "ci.yml"), "utf8"))
		const verified = verifyGates()
		const ran = steps.flatMap(({ command }) => {
			const script = command === undefined ? undefined : scriptOf(command)
			return script === undefined ? [] : [script]
		})
		const other = steps.filter(({ command }) => command === undefined || scriptOf(command) === undefined)
		expect([...new Set(ran)].toSorted()).toEqual([...verified].toSorted())
		expect(
			other.filter(({ command, name }) =>
				command === undefined ? !SETUP.names.includes(name ?? "") : !SETUP.commands.includes(command),
			),
		).toEqual([])
	})

	it("reads a step's script through comb's package filter, and a block step by its name", () => {
		expect(
			ciSteps(
				"      - run: bun run --filter @lovrozagar/comb test:e2e\n      - name: x\n        run: |\n          y\n",
			),
		).toEqual([{ command: "bun run --filter @lovrozagar/comb test:e2e" }, { name: "x" }])
		expect(scriptOf("bun run --filter @lovrozagar/comb test:e2e")).toBe("test:e2e")
		expect(scriptOf("bun install --frozen-lockfile")).toBeUndefined()
	})
})

/*
 * CI's runners are in UTC, so every local test run is too: a time-zone-dependent expectation that
 * passed in another zone passed verify and failed CI (U20's row 8). The vitest configs pin TZ before
 * their workers fork, and bun's preload pins it for its suites, whatever the shell's TZ.
 */
describe("the time zone every test run uses", () => {
	const CORE = join(ROOT, "packages/core")
	const PIN = 'process.env.TZ = "UTC"'

	it("is UTC in this run", () => {
		expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe("UTC")
		expect(new Date(2000, 0, 1).getTimezoneOffset()).toBe(0)
	})

	it("is pinned in every vitest config and in bun's preload", () => {
		const configs = readdirSync(CORE).filter((name) => /^vitest(\..+)?\.config\.ts$/.test(name))
		expect(configs.length).toBeGreaterThanOrEqual(3)
		for (const name of configs) expect(readFileSync(join(CORE, name), "utf8"), name).toContain(PIN)
		const bunfig = readFileSync(join(CORE, "bunfig.toml"), "utf8")
		const preload = /^preload = \["\.\/(.+?)"\]$/m.exec(bunfig)?.[1]
		expect(preload).toBe("tests/bun/support/utc.ts")
		expect(readFileSync(join(CORE, preload as string), "utf8")).toContain(PIN)
	})
})

/*
 * The suites that page or read Date keys run a second time far from UTC (tests/support/off-utc.ts):
 * every one of them, found by its own text, so a new one cannot miss the pass, in a zone whose
 * offset is no whole hour, so no hour-rounding hides a bug.
 */
describe("the pass of the Date-key suites off UTC", () => {
	const CORE = join(ROOT, "packages/core")

	/** Every test file under `dir`, relative to packages/core */
	const testFiles = (dir: string): string[] =>
		(readdirSync(join(CORE, dir), { recursive: true }) as string[])
			.filter((name) => name.endsWith(".test.ts"))
			.map((name) => `${dir}/${name}`)

	it("takes every suite that touches a Date key, and no other", () => {
		const scanned = [...testFiles("src"), ...testFiles("tests/integration")]
			.filter((file) => DATE_KEYS.test(readFileSync(join(CORE, file), "utf8")))
			.toSorted()
		expect([...OFF_UTC_UNIT, ...OFF_UTC_INTEGRATION].toSorted()).toEqual(scanned)
	})

	/* a function whose name ends in timestamp, as Postgres's clock_timestamp(), is no comb timestamp column */
	it("takes c.timestamp( as a Date key, and no name that only ends in timestamp(", () => {
		expect(DATE_KEYS.test('c.timestamp("at")')).toBe(true)
		expect(DATE_KEYS.test("timestamp(")).toBe(true)
		expect(DATE_KEYS.test("DEFAULT clock_timestamp()")).toBe(false)
		expect(DATE_KEYS.test("now_timestamp(")).toBe(false)
		expect(DATE_KEYS.test("$timestamp(")).toBe(false)
	})

	it("runs them in a zone whose offset is a fraction of an hour, in both projects of the config", () => {
		const offset = new Intl.DateTimeFormat("en-US", { timeZone: OFF_UTC_ZONE, timeZoneName: "longOffset" })
			.formatToParts(new Date(2000, 0, 1))
			.find((part) => part.type === "timeZoneName")?.value
		expect(offset).toMatch(/^GMT[+-]\d{2}:(?!00)\d{2}$/)
		const config = readFileSync(join(CORE, "vitest.config.ts"), "utf8")
		expect(config.match(/env: \{ TZ: OFF_UTC_ZONE \}/g)).toHaveLength(2)
		expect(config).toContain("include: OFF_UTC_UNIT")
		expect(config).toContain("include: OFF_UTC_INTEGRATION")
	})
})
