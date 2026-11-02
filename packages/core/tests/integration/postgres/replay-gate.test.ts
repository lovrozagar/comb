/**
 * P3 of r20: the docker:// gate (pg-replay-gate.ts) passes a history without comb's replay only when
 * every statement is one it holds inert. Each inert node and ALTER TABLE command runs here on Postgres,
 * in a schema of its own after the fixture's setup, and the catalog read baseline compares
 * (pg-live-catalog.ts) finds nothing after it, so an arm the read gains is held to every entry. OWNED BY
 * NONE, which 0.18's makers list let through, is the control: the read finds the sequence it frees.
 */
import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { COMMAND_SAMPLES, NODE_SAMPLES, SETUP } from "../../../src/migrate/__fixtures__/inert-statements.ts"
import { noLive } from "../../../src/migrate/__fixtures__/live-objects.ts"
import { readLiveObjects } from "../../../src/migrate/core/pg-live-objects.ts"
import { pgUrl } from "../support/pg.ts"

const server = new URL(pgUrl())
const DATABASE = `comb_gate_${process.pid}`
const url = Object.assign(new URL(server.href), { pathname: `/${DATABASE}` }).href
const admin = new pg.Client({ connectionString: server.href })

beforeAll(async () => {
	await admin.connect()
	await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`)
	await admin.query(`CREATE DATABASE ${DATABASE}`)
})

afterAll(async () => {
	await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`)
	await admin.end()
})

let schemas = 0

/** What the catalog read finds in a schema of its own after the setup and `sql`, in one transaction */
async function readAfter(sql: string) {
	const schema = `gate_${(schemas += 1)}`
	const client = new pg.Client({ connectionString: url })
	await client.connect()
	try {
		await client.query(
			["BEGIN", `CREATE SCHEMA ${schema}`, `SET LOCAL search_path = ${schema}`, ...SETUP, sql, "COMMIT"].join(";\n"),
		)
	} finally {
		await client.end()
	}
	const read = await readLiveObjects({ schema, url })
	return { ...read, user: "app" }
}

describe("the docker:// gate's inert statements, on Postgres", () => {
	it.each([...Object.entries(NODE_SAMPLES), ...Object.entries(COMMAND_SAMPLES)])(
		"%s leaves nothing the catalog read compares",
		async (_, sql) => {
			expect(await readAfter(sql)).toEqual(noLive())
		},
	)

	it("reads the sequence OWNED BY NONE frees, which the gate refuses", async () => {
		const read = await readAfter("ALTER SEQUENCE t_id_seq OWNED BY NONE")
		expect([...read.relations]).toEqual([["t_id_seq", "sequence"]])
	})
})
