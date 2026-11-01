/**
 * Q11 of r18: a libsql or Turso connection refused, or a server that answers it can't serve, is the
 * 503 a retry may fix, as on D1 and Postgres; a request the server refuses is not. @libsql/client
 * over HTTP, against a closed port and a local server answering each status.
 */
import { createClient } from "@libsql/client"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { classifySqliteError } from "../../../src/sqlite/constraint-handler.ts"

let server: Server | undefined
afterEach(async () => {
	await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)))
	server = undefined
})

/** What `url`'s client fails a query with */
async function failure(url: string): Promise<unknown> {
	const client = createClient({ url })
	try {
		return await client.execute("SELECT 1").then(
			() => new Error("the query did not fail"),
			(error: unknown) => error,
		)
	} finally {
		client.close()
	}
}

/** A local server answering every request with `status`, and its URL */
async function answering(status: number): Promise<string> {
	const listening = createServer((_, response) => response.writeHead(status).end())
	server = listening
	await new Promise<void>((resolve) => listening.listen(0, "127.0.0.1", resolve))
	return `http://127.0.0.1:${(listening.address() as AddressInfo).port}`
}

describe("classifySqliteError on a lost libsql connection", () => {
	it("answers a refused connection as database_unavailable 503", async () => {
		const closed = await answering(200)
		await new Promise((resolve) => server?.close(resolve))
		server = undefined
		expect(classifySqliteError(await failure(closed), [])).toMatchObject({
			errorKey: "database_unavailable",
			status: 503,
		})
	})

	it.each([503, 502, 429])("answers a server's %i as database_unavailable 503", async (status) => {
		expect(classifySqliteError(await failure(await answering(status)), [])).toMatchObject({
			errorKey: "database_unavailable",
			status: 503,
		})
	})

	it("leaves a request the server refuses, and a host that does not exist, unclassified", async () => {
		expect(classifySqliteError(await failure(await answering(400)), [])).toBeUndefined()
		expect(classifySqliteError(await failure("http://no-such-host.invalid"), [])).toBeUndefined()
	})
})
