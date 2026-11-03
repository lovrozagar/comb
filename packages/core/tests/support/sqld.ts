/**
 * The pinned libsql server (sqld) the remote-libsql suites run against: a real server, since what it
 * refuses at parse and how it words an error only show on the binary (S1 and QE1 of r22). CI's test
 * job downloads the release archive by version, checks its sha256 and unpacks it at `SQLD_PATH`
 * (.github/workflows/ci.yml, held by tests/structure/workflows.test.ts); locally the same commands
 * put it there. Every start checks the binary's sha256, and a missing binary or a mismatch fails the
 * suite rather than skipping it.
 */
import { type ChildProcess, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import os from "node:os"
import path from "node:path"

/** The sqld release every suite runs: libsql-server-v0.24.32 (40c272de, 2025-02-14) */
export const SQLD_VERSION = "0.24.32"

/** The release archive CI fetches, and its sha256 as the release's own `.sha256` file states it */
export const SQLD_ARCHIVE = {
	sha256: "71720fc8648c19efef416efebd47145ef59b62e198770533530a858e1336879f",
	url: `https://github.com/tursodatabase/libsql/releases/download/libsql-server-v${SQLD_VERSION}/libsql-server-x86_64-unknown-linux-gnu.tar.xz`,
}

/** The sha256 of the `sqld` binary inside that archive, checked on every start */
export const SQLD_SHA256 = "0863c3fbe68ac9714bca2cec1330def7a0ba5e4a29f199bf60ef46fa0c95b895"

/** Where the binary lives: the archive unpacked under `~/.cache/comb-test/sqld/<version>/` */
export const SQLD_PATH = path.join(
	os.homedir(),
	".cache/comb-test/sqld",
	SQLD_VERSION,
	"libsql-server-x86_64-unknown-linux-gnu/sqld",
)

/** How to put the pinned binary in place, which a failure names */
const INSTALL = `mkdir -p ~/.cache/comb-test/sqld/${SQLD_VERSION} && cd ~/.cache/comb-test/sqld/${SQLD_VERSION} && curl -sSfL -o sqld.tar.xz ${SQLD_ARCHIVE.url} && echo "${SQLD_ARCHIVE.sha256}  sqld.tar.xz" | sha256sum -c - && tar -xJf sqld.tar.xz`

/** The pinned binary's path, after checking it is there and is the pinned build; throws otherwise */
export function requireSqld(file: string = SQLD_PATH): string {
	if (!existsSync(file))
		throw new Error(`sqld ${SQLD_VERSION} is not at ${file}: the remote libsql suites are required; ${INSTALL}`)
	const sha = createHash("sha256").update(readFileSync(file)).digest("hex")
	if (sha !== SQLD_SHA256)
		throw new Error(`${file} has sha256 ${sha}, not sqld ${SQLD_VERSION}'s ${SQLD_SHA256}; ${INSTALL}`)
	return file
}

const freePort = (): Promise<number> =>
	new Promise((resolve, reject) => {
		const server = createServer()
		server.once("error", reject)
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as { port: number }
			server.close(() => resolve(port))
		})
	})

/** A running sqld on a database of its own: its Hrana URLs over HTTP and WebSocket, and how to stop it */
export type Sqld = { http: string; proc: ChildProcess; stop(): Promise<void>; ws: string }

/** The pinned sqld started on a fresh database and a free port, answering its health check */
export async function startSqld(): Promise<Sqld> {
	const bin = requireSqld()
	const dir = mkdtempSync(path.join(os.tmpdir(), "comb-sqld-"))
	const port = await freePort()
	const proc = spawn(
		bin,
		["--db-path", path.join(dir, "data.sqld"), "--http-listen-addr", `127.0.0.1:${port}`, "--no-welcome"],
		{ stdio: ["ignore", "ignore", "pipe"] },
	)
	let stderr = ""
	proc.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString()
	})
	const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()))
	const stop = async () => {
		if (proc.exitCode === null && proc.signalCode === null) {
			proc.kill("SIGTERM")
			await exited
		}
		rmSync(dir, { force: true, recursive: true })
	}
	for (let i = 0; i < 200; i++) {
		if (proc.exitCode !== null) break
		try {
			if ((await fetch(`http://127.0.0.1:${port}/health`)).ok)
				return { http: `http://127.0.0.1:${port}`, proc, stop, ws: `ws://127.0.0.1:${port}` }
		} catch {
			// reason: the server is not listening yet; the loop waits for it
		}
		await new Promise((resolve) => setTimeout(resolve, 50))
	}
	await stop()
	throw new Error(`sqld ${SQLD_VERSION} did not answer its health check on port ${port}: ${stderr.trim()}`)
}
