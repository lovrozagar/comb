/**
 * P11 of r19: comb's own read and Atlas take one password from one passfile, read by Atlas's driver's
 * host rule (pg-passfile.ts). Each shape gives a role with a password one right and one wrong line, and
 * comb and real Atlas must connect or fail together. CI's Postgres checks passwords, so it is real
 * there. The local test server trusts every password, so it cannot fail this suite: both always
 * connect. Its red was shown on a password-checking cluster with P11 reverted
 * (.tmp/grunt/p18/runs/*-p11-ci-red-*). Only TCP shapes: CI's server has no socket to reach.
 */
import { randomUUID } from "node:crypto"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { readLiveObjects } from "../../../src/migrate/core/pg-live-objects.ts"
import { run } from "../../../src/migrate/core/process.ts"
import { pgUrl } from "../support/pg.ts"

const server = new URL(pgUrl() as string)
const role = `comb_pf_${randomUUID().replaceAll("-", "").slice(0, 12)}`
const dir = mkdtempSync(join(tmpdir(), "comb-passfile-"))

/** Run `sql` as the test server's own user */
async function admin(sql: string): Promise<void> {
	const client = new pg.Client({ connectionString: server.href })
	await client.connect()
	try {
		await client.query(sql)
	} finally {
		await client.end()
	}
}

beforeAll(() => admin(`CREATE ROLE ${role} LOGIN PASSWORD 'right'`))
afterAll(async () => {
	await admin(`DROP ROLE IF EXISTS ${role}`)
	rmSync(dir, { force: true, recursive: true })
})

/** A passfile line for `host` on the test server's port, giving `password` */
const line = (host: string, password: string) => `${host}:${server.port}:*:${role}:${password}`

/** The URL of a shape, by its authority host and extra query, with the passfile at `file` */
const urlOf = (host: string, query: string, file: string) =>
	`postgres://${role}@${host}:${server.port}${server.pathname}?sslmode=disable${query}&passfile=${encodeURIComponent(file)}`

/** A URL shape: its authority host, its extra query, and its passfile's lines */
type Shape = { host: string; label: string; lines: readonly string[]; query: string }

const ADDR = "&hostaddr=127.0.0.1"
const SHAPES: readonly Shape[] = [
	{ host: "", label: "hostaddr only, its line", lines: [line("127.0.0.1", "right")], query: ADDR },
	{ host: "", label: "hostaddr only, localhost's line", lines: [line("localhost", "right")], query: ADDR },
	{
		host: "",
		label: "hostaddr only, localhost wrong before the hostaddr right",
		lines: [line("localhost", "wrong"), line("127.0.0.1", "right")],
		query: ADDR,
	},
	{ host: "localhost", label: "host and hostaddr, the host's line", lines: [line("localhost", "right")], query: ADDR },
	{
		host: "localhost",
		label: "host and hostaddr, the hostaddr's line",
		lines: [line("127.0.0.1", "right")],
		query: ADDR,
	},
	{ host: "127.0.0.1", label: "host 127.0.0.1, its line", lines: [line("127.0.0.1", "right")], query: "" },
	{ host: "127.0.0.1", label: "host 127.0.0.1, localhost's line", lines: [line("localhost", "right")], query: "" },
]

describe("a passfile read by comb and by Atlas", () => {
	it.each(SHAPES)("$label: comb and Atlas connect or fail together", async ({ host, label, lines, query }) => {
		const file = join(dir, label.replaceAll(/\W+/g, "_"))
		writeFileSync(file, `${lines.join("\n")}\n`)
		chmodSync(file, 0o600)
		const url = urlOf(host, query, file)
		const atlas = await run("atlas", ["schema", "inspect", "-u", url, "--format", "{{ len .Realm.Schemas }}"])
		const comb = await readLiveObjects({ schema: "public", url }).then(
			() => "connects",
			(error: Error) => `fails: ${error.message}`,
		)
		expect(comb === "connects", `comb ${comb}; Atlas ${atlas.code === 0 ? "connects" : `fails: ${atlas.stderr}`}`).toBe(
			atlas.code === 0,
		)
	})
})
