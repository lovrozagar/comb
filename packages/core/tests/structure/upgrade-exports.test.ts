/**
 * K3 of r18 and r19: the README's newest "Upgrading to" section lists exactly the exports the package
 * adds, removes or changes since the release it upgrades from, so it never promises an export that
 * is not there, nor leaves one out, nor hides a changed signature, and it names each member a type
 * the release's exports reach lost or made required. The release's exports, each with a hash of its
 * emitted declaration, and the members of those types are checked in (__snapshots__/released-exports.json); after a
 * release, regenerate them from the tag with support/write-released-exports.ts.
 */
import { spawnSync } from "node:child_process"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { ts } from "ts-morph"
import { describe, expect, it } from "vitest"
import { apiOf, type Exports, type Members } from "./support/exports-of.ts"

const ROOT = join(import.meta.dirname, "../..")
const RELEASED = JSON.parse(readFileSync(join(import.meta.dirname, "__snapshots__/released-exports.json"), "utf8")) as {
	exports: Exports
	members: Members
	version: string
}
const README = readFileSync(join(ROOT, "../../README.md"), "utf8")

/** The newest "## Upgrading to X" section, and X */
function newestUpgrade(): { section: string; version: string } {
	const at = README.indexOf("\n## Upgrading to ")
	const next = README.indexOf("\n## ", at + 1)
	const section = README.slice(at, next === -1 ? undefined : next)
	return { section, version: /^\n## Upgrading to (\S+)/.exec(section)?.[1] as string }
}

/** Each name `to` has and `from` lacks, sorted, once */
const missingFrom = (from: Exports, to: Exports): string[] => {
	const names = Object.entries(to).flatMap(([subpath, each]) =>
		Object.keys(each).filter((name) => from[subpath]?.[name] === undefined),
	)
	return [...new Set(names)].sort()
}

/** Each name both have whose declaration differs, sorted, once */
const differing = (from: Exports, to: Exports): string[] => {
	const names = Object.entries(to).flatMap(([subpath, each]) =>
		Object.entries(each)
			.filter(([name, hash]) => (from[subpath]?.[name] ?? hash) !== hash)
			.map(([name]) => name),
	)
	return [...new Set(names)].sort()
}

/**
 * Each member of a type the release reached that the type still declared now lacks, or that was
 * optional there and is required now, as `Type.member`, sorted: a type no export reaches now is
 * the export lists' to name
 */
const narrowed = (from: Members, to: Members): string[] =>
	Object.entries(from)
		.flatMap(([type, members]) =>
			to[type] === undefined
				? []
				: Object.entries(members)
						.filter(([member, was]) => {
							const now = to[type]?.[member]
							return now === undefined || (was === "optional" && now === "required")
						})
						/* a type keyed `Name (file)`, one of two of that name, is still `Name` to a reader */
						.map(([member]) => `${type.replace(/ \(.*\)$/, "")}.${member}`),
		)
		.sort()

const API = join(import.meta.dirname, "__snapshots__/api")

/** The snapshot's subpath: `index` is `.`, `a__b` is `./a/b` */
const subpathOf = (file: string): string =>
	file === "index.d.ts.txt" ? "." : `./${file.replace(/\.d\.ts\.txt$/, "").replaceAll("__", "/")}`

/** `type` without its parentheses, and without `| undefined` when that leaves one type */
function bare(type: ts.TypeNode | undefined): ts.TypeNode | undefined {
	if (type !== undefined && ts.isParenthesizedTypeNode(type)) return bare(type.type)
	if (type === undefined || !ts.isUnionTypeNode(type)) return type
	const defined = type.types.filter((each) => each.kind !== ts.SyntaxKind.UndefinedKeyword)
	return defined.length === 1 ? bare(defined[0]) : type
}

/** The members of an interface or an object type alias, by its name */
function membersOf(node: ts.Node): [string, ts.NodeArray<ts.TypeElement>] | undefined {
	if (ts.isInterfaceDeclaration(node)) return [node.name.text, node.members]
	if (ts.isTypeAliasDeclaration(node) && ts.isTypeLiteralNode(node.type)) return [node.name.text, node.type.members]
	return undefined
}

/**
 * Each callable a snapshot declares, and whether it returns a promise: a function, a const or a type
 * of function type, and, as `Type.member` (D6-4 of the area D round-six review), a method or a
 * function-typed member of an interface or object type, a member typed by a callable alias among them
 */
function callablesOf(text: string): Map<string, boolean> {
	const found = new Map<string, boolean>()
	const mark = (name: string, promise: boolean) => found.set(name, found.get(name) === true || promise)
	const note = (name: string, type: ts.TypeNode | undefined) => mark(name, /^Promise\s*</.test(type?.getText() ?? ""))
	const noteMember = (name: string, member: ts.TypeElement): void => {
		if (ts.isMethodSignature(member)) return void note(name, member.type)
		const type = ts.isPropertySignature(member) ? bare(member.type) : undefined
		if (type !== undefined && ts.isFunctionTypeNode(type)) note(name, type.type)
		const alias = type !== undefined && ts.isTypeReferenceNode(type) ? found.get(type.typeName.getText()) : undefined
		if (alias !== undefined) mark(name, alias)
	}
	const visit = (node: ts.Node): void => {
		if (ts.isFunctionDeclaration(node) && node.name !== undefined) note(node.name.text, node.type)
		if ((ts.isVariableDeclaration(node) || ts.isTypeAliasDeclaration(node)) && ts.isIdentifier(node.name)) {
			if (node.type !== undefined && ts.isFunctionTypeNode(node.type)) note(node.name.text, node.type.type)
		}
		ts.forEachChild(node, visit)
	}
	/* the members after every alias, which a snapshot may declare after the type that names it */
	const visitMembers = (node: ts.Node): void => {
		const [type, members] = membersOf(node) ?? ["", []]
		for (const member of members)
			if (member.name !== undefined && ts.isIdentifier(member.name)) noteMember(`${type}.${member.name.text}`, member)
		ts.forEachChild(node, visitMembers)
	}
	const source = ts.createSourceFile("snapshot.d.ts", text, ts.ScriptTarget.Latest, true)
	visit(source)
	visitMembers(source)
	return found
}

/** The snapshot `file` at the release's tag, or nothing when the release had no such subpath */
function releasedSnapshot(file: string, version: string): string {
	const path = `packages/core/tests/structure/__snapshots__/api/${file}`
	const shown = spawnSync("git", ["show", `v${version}:${path}`], { cwd: ROOT, encoding: "utf8" })
	if (shown.status === 0) return shown.stdout
	expect(shown.stderr, `git show v${version}:${path}`).toMatch(/does not exist|exists on disk, but not in/)
	return ""
}

/** Each public callable the release exports that returned no promise there and returns one now, sorted, once */
function becamePromises(exports: Exports, version: string): string[] {
	const names = readdirSync(API).flatMap((file) => {
		const now = callablesOf(readFileSync(join(API, file), "utf8"))
		const then = callablesOf(releasedSnapshot(file, version))
		const exported = exports[subpathOf(file)] ?? {}
		/* a member counts when its type is exported: `CliIo.run` with `CliIo` */
		return [...then.keys()].filter(
			(name) =>
				exported[name.split(".")[0] as string] !== undefined && then.get(name) === false && now.get(name) === true,
		)
	})
	return [...new Set(names)].sort()
}

/** The section's one paragraph opening "`a`, `b` … return a promise:", and that clause, up to its colon */
function promiseParagraph(section: string): { clause: string; paragraph: string } {
	const lines = [...section.matchAll(/^ *(`[^:\n]*? returns? a promise[^:\n]*):.*$/gm)]
	expect(lines, 'one "… return a promise:" sentence in the section').toHaveLength(1)
	return { clause: lines[0]?.[1] ?? "", paragraph: lines[0]?.[0] ?? "" }
}

/** The backticked names in the section's one "`a`, `b` … return a promise:" clause, sorted */
const promised = (section: string): string[] =>
	[...promiseParagraph(section).clause.matchAll(/`([^`]+)`/g)].map((match) => match[1] as string).sort()

/** The backticked names on the section's one `label:` line, sorted; `none.` names none */
function listed(section: string, label: string): string[] {
	const lines = [...section.matchAll(new RegExp(`^ *${label}: (.+)$`, "gm"))]
	expect(lines, `one "${label}:" line in the section`).toHaveLength(1)
	const names = (lines[0]?.[1] ?? "").matchAll(/`([^`]+)`/g)
	return [...names].map((match) => match[1] as string).sort()
}

describe("the newest upgrade section's exports", () => {
	const api = apiOf(ROOT)
	const now = api.exports
	const { section, version } = newestUpgrade()

	/* right after a release the newest section is the release's own, and the snapshot is regenerated from its tag */
	const [major, minor] = version.split(".").map(Number)
	const [wasMajor, wasMinor] = RELEASED.version.split(".").map(Number)
	const released = major === wasMajor && minor === wasMinor
	const since = {
		changed: differing(RELEASED.exports, now),
		new: missingFrom(RELEASED.exports, now),
		removed: missingFrom(now, RELEASED.exports),
	}

	it("upgrades from the release the exports are checked in from, or is that release's own", () => {
		expect(
			released || (major === wasMajor ? (minor as number) - (wasMinor as number) : 1) === 1,
			`Upgrading to ${version} from ${RELEASED.version}`,
		).toBe(true)
	})

	it("lists exactly what changed since then; nothing has, while the section is the release's own", () => {
		/* an export changed after the release opens the next version's section, which lists it */
		const lists = released
			? { changed: [], new: [], removed: [] }
			: {
					changed: listed(section, "Changed"),
					new: listed(section, "New exports"),
					removed: listed(section, "Removed"),
				}
		expect(lists, `changed since ${RELEASED.version}, against "Upgrading to ${version}"`).toEqual(since)
	})

	/* comb-44's 0005 dropped `ManifestConfig.filePrefix`, which 0.20.1's generateManifest takes, and no list could name it */
	it("names each member a released type lost or made required since then, as `Type.member` or `member`", () => {
		const unnamed = narrowed(RELEASED.members, api.members).filter(
			(name) => !section.includes(`\`${name}\``) && !section.includes(`\`${name.split(".")[1]}\``),
		)
		expect(released ? [] : unnamed, `narrowed since ${RELEASED.version}, unnamed in "Upgrading to ${version}"`).toEqual(
			[],
		)
	})

	/* D5-1 of the area D round-five review: the async paragraph left out exportDrizzleSchema and named a bare run */
	it("names, in its async paragraph, exactly the public callables that return a promise since then", () => {
		const became = becamePromises(RELEASED.exports, RELEASED.version).filter((name) => !name.includes("."))
		expect(released ? [] : promised(section), `became promises since ${RELEASED.version}`).toEqual(became)
	})

	/* D6-4 of the area D round-six review: a runner an embedder passes, `CliIo.run`, became async too */
	it("names in that paragraph each member of a public type that returns a promise since then", () => {
		const became = becamePromises(RELEASED.exports, RELEASED.version).filter((name) => name.includes("."))
		expect(released ? [] : became).toContain("CliIo.run")
		const paragraph = released ? "" : promiseParagraph(section).paragraph
		expect(became.filter((name) => !paragraph.includes(`\`${name}\``))).toEqual([])
	})
})
