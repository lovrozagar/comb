/**
 * The bin peers comb spawns, wrangler and drizzle-kit, in a Bun workspace from the packed tarball:
 * comb checks, reads and runs the one package the project holds, from the working folder up, on the
 * runtime it keeps for each, and never one on PATH (K1 and K3 of r22).
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { ok, pack, peerRange, REQUIRED_PEERS, run, TOOLS } from "./stage.ts"

let tarball: string
beforeAll(() => {
	tarball = pack()
})
afterAll(() => rmSync(dirname(tarball), { force: true, recursive: true }))

/*
 * K1 of r22: 0.20.1 checked the wrangler comb's own import resolved and spawned the one on PATH, so
 * in a workspace the check spoke for another package than the one that ran. Bun workspaces, comb
 * hoisted to the root, each bin peer at one version in the root and another in the workspace `db`.
 * Every peer is a fake whose bin logs its version, the runtime it runs on and its argv, and exits 1;
 * wrangler's module logs the config read
 */
describe("comb runs the bin it checked (K1; sibling: drizzle-kit's resolution)", () => {
	const IN = { "drizzle-kit": "1.0.0-rc.5", wrangler: "4.150.0" } as const
	const OUT = { "drizzle-kit": "0.31.0", wrangler: "3.99.0" } as const
	type BinPeer = keyof typeof IN
	/** A fake `peer` at `version`, its bin where its package.json says, not where comb would guess */
	const fake = (peer: BinPeer, version: string): Record<string, string> => {
		const log = `require("node:fs").appendFileSync(process.cwd() + "/ran.log", ${JSON.stringify(`${peer} ${version} `)} + `
		return {
			"bin/run-fake.js": `#!/usr/bin/env node
${log}require("node:path").basename(process.execPath) + " " + process.argv.slice(2).join(" ") + "\\n")
process.stderr.write(${JSON.stringify(`fake ${peer} ${version}\n`)})
process.exit(1)
`,
			"index.js": `exports.unstable_readConfig = () => {
	${log}"readConfig\\n")
	return { d1_databases: [{ binding: "CORE", database_id: "00000000-0000-0000-0000-000000000000", database_name: "core", migrations_dir: "m" }] }
}
`,
			"package.json": JSON.stringify({ bin: { [peer]: "bin/run-fake.js" }, main: "index.js", name: peer, version }),
		}
	}
	const DB = {
		"comb.migrate.config.ts": `export default { databases: { core: { migrationsDir: "m", name: "core", provider: { type: "d1", databaseName: "core" } } } }\n`,
		"drizzle.config.ts": `export default { dialect: "sqlite", out: "./m", schema: "./post.tables.ts" }\n`,
		"m/20260101000000_init.sql": "CREATE TABLE a (id integer);\n",
		"post.tables.ts": `import { sqliteTable } from "drizzle-orm/sqlite-core"
import { c } from "@lovrozagar/comb/sqlite/columns"
export const post = sqliteTable("post", { id: c.id("id", { prefix: "post" }) })
`,
		"wrangler.jsonc": JSON.stringify({
			compatibility_date: "2025-01-01",
			d1_databases: [
				{
					binding: "CORE",
					database_id: "00000000-0000-0000-0000-000000000000",
					database_name: "core",
					migrations_dir: "m",
				},
			],
			name: "w",
		}),
	}
	const COMB = join("..", ["node_", "modules"].join(""), "@lovrozagar/comb/src/bin.ts")
	/* each command under bun (comb's own shebang) and under node (through tsx), as a package script runs it */
	const SCRIPTS = {
		"diff:bun": "comb migrate diff core --dry-run",
		"diff:node": `tsx ${COMB} migrate diff core --dry-run`,
		"status:bun": "comb migrate status core",
		"status:node": `tsx ${COMB} migrate status core`,
	}
	const dirs: string[] = []
	afterAll(() => {
		for (const dir of dirs) rmSync(dir, { force: true, recursive: true })
	})

	const write = (dir: string, files: Record<string, string>) => {
		for (const [file, text] of Object.entries(files)) {
			mkdirSync(dirname(join(dir, file)), { recursive: true })
			writeFileSync(join(dir, file), text)
		}
	}

	/** A workspace root with `root`'s peers and a workspace `db` with `db`'s, each a fake; none when undefined */
	const workspace = (root: Record<string, string> | undefined, db: Record<string, string> | undefined): string => {
		const dir = mkdtempSync(join(tmpdir(), "comb-consumer-bins-"))
		dirs.push(dir)
		const deps = (peers: Record<string, string> | undefined, at: string) =>
			Object.fromEntries(
				Object.entries(peers ?? {}).map(([peer, version]) => {
					const where = join(dir, "fakes", `${peer}-${version}`)
					write(where, fake(peer as BinPeer, version))
					return [peer, `file:${relative(at, where)}`]
				}),
			)
		write(dir, {
			"package.json": JSON.stringify({
				dependencies: { "@lovrozagar/comb": `file:${tarball}`, ...REQUIRED_PEERS, ...deps(root, dir) },
				devDependencies: { tsx: TOOLS.tsx },
				name: "ws-root",
				private: true,
				workspaces: ["db"],
			}),
		})
		write(join(dir, "db"), {
			...DB,
			"package.json": JSON.stringify({
				dependencies: deps(db, join(dir, "db")),
				name: "db",
				private: true,
				scripts: SCRIPTS,
				type: "module",
			}),
		})
		ok(run(dir, "bun", ["install"]), "bun install")
		return join(dir, "db")
	}

	/** `bun run name` in the workspace `db`, with `path` ahead of PATH, and what each fake logged */
	const script = (db: string, name: keyof typeof SCRIPTS, path?: string) => {
		rmSync(join(db, "ran.log"), { force: true })
		const set: Record<string, string> = path === undefined ? {} : { PATH: `${path}:${process.env["PATH"] ?? ""}` }
		const result = run(db, "bun", ["run", name], set)
		const ran = existsSync(join(db, "ran.log")) ? readFileSync(join(db, "ran.log"), "utf8").trim().split("\n") : []
		return { ran, result }
	}

	/* the peer each command spawns, and the runtime it keeps from 0.20.1: wrangler node whatever runs comb, and
	   drizzle-kit the runtime running comb, as `bun drizzle-kit` followed its node shebang there (AD5 of the area D review) */
	const SPAWNS = (["bun", "node"] as const).flatMap((comb) => [
		{ comb, command: "status", peer: "wrangler", runtime: "node" } as const,
		{ comb, command: "diff", peer: "drizzle-kit", runtime: comb } as const,
	])

	describe("the workspace's own peer in range, the root's out of it", () => {
		let db: string
		beforeAll(() => {
			db = workspace(OUT, IN)
		})

		it.each(SPAWNS)(
			"a check that passes runs the $peer it checked on $runtime ($command, comb on $comb)",
			({ comb, command, peer, runtime }) => {
				const { ran, result } = script(db, `${command}:${comb}`)
				expect(result.output).toContain(`fake ${peer} ${IN[peer]}`)
				expect(result.output).not.toContain("comb needs")
				expect(ran.length).toBeGreaterThan(0)
				for (const line of ran) expect(line.startsWith(`${peer} ${IN[peer]} `), line).toBe(true)
				const spawned = ran.filter((line) => !line.endsWith(" readConfig"))
				expect(spawned.length).toBe(1)
				expect(spawned[0]?.split(" ")[2]).toBe(runtime)
			},
		)
	})

	describe("the root's peer in range, the workspace's own out of it", () => {
		let db: string
		beforeAll(() => {
			db = workspace(IN, OUT)
		})

		it.each(SPAWNS)("a refusal names the $peer comb would run ($command, comb on $comb)", ({ comb, command, peer }) => {
			const { ran, result } = script(db, `${command}:${comb}`)
			expect(result.status).not.toBe(0)
			expect(result.output).toContain(`comb needs ${peer} (${peerRange(peer)}, found ${OUT[peer]}) to `)
			expect(ran).toEqual([])
		})
	})

	/* K3 of r22: comb reads no PATH, so the refusal sends no one to put node_modules/.bin on it */
	it("refuses a wrangler only on PATH with the range and the install alone (K3)", () => {
		const db = workspace(undefined, undefined)
		const bin = join(db, "global-bin")
		write(bin, { wrangler: fake("wrangler", IN.wrangler)["bin/run-fake.js"] as string })
		chmodSync(join(bin, "wrangler"), 0o755)
		const { ran, result } = script(db, "status:bun", bin)
		expect(result.status).not.toBe(0)
		expect(result.output).toContain(
			`comb needs wrangler (${peerRange("wrangler")}) to migrate a D1 database; install "wrangler@${peerRange("wrangler")}"`,
		)
		expect(result.output).not.toContain("PATH")
		expect(ran).toEqual([])
	})
})
