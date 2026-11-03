/**
 * Local servers that lose a libsql request as a network does, for the errors the real
 * @libsql/client throws (S3 of r21): a refused port, a connection closed once the request is read,
 * an HTTP status, and over a WebSocket one closed after the upgrade, mid-request
 */
import { createClient } from "@libsql/client"
import { createHash } from "node:crypto"
import { createServer, type Server, type Socket } from "node:net"

type Scheme = "http" | "ws"
type Answer = "closed" | "refused" | "upgraded, then closed" | number

/* RFC 6455's key a server's handshake answers with */
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

/** The 101 that upgrades the request `head` to the first protocol it offers, as sqld answers */
function upgrade(head: string): string {
	const header = (name: string) => new RegExp(`^${name}: *(.+?)\\r?$`, "im").exec(head)?.[1] ?? ""
	const accept = createHash("sha1")
		.update(`${header("Sec-WebSocket-Key")}${GUID}`)
		.digest("base64")
	const [protocol] = header("Sec-WebSocket-Protocol").split(/, */)
	return `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: ${protocol}\r\n\r\n`
}

/** What the server does with a connection's request: `answer` to it */
function respond(socket: Socket, answer: Exclude<Answer, "refused">): void {
	socket.once("data", (request) => {
		if (answer === "closed") socket.destroy()
		else if (answer === "upgraded, then closed") {
			socket.write(upgrade(request.toString()))
			socket.once("data", () => socket.destroy())
		} else
			socket.end(
				`HTTP/1.1 ${answer} No\r\ncontent-type: text/plain\r\ncontent-length: 2\r\nconnection: close\r\n\r\nno`,
			)
	})
}

/** A server on a free local port answering each connection with `answer`; a refused one listens no longer */
async function serving(answer: Answer): Promise<{ port: number; server: Server }> {
	const server = createServer((socket) => respond(socket, answer as Exclude<Answer, "refused">))
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const { port } = server.address() as { port: number }
	if (answer === "refused") await new Promise((resolve) => server.close(resolve))
	return { port, server }
}

/** What the real client throws for a write batch to a `scheme` server that answers `answer` */
export async function lostRequest(scheme: Scheme, answer: Answer): Promise<unknown> {
	const { port, server } = await serving(answer)
	const client = createClient({ url: `${scheme}://127.0.0.1:${port}` })
	try {
		return await client.batch([{ args: [], sql: "SELECT 1" }], "write").then(
			() => new Error("the batch did not fail"),
			(error: unknown) => error,
		)
	} finally {
		client.close()
		server.close()
	}
}

/** What the real client throws for a request after comb closed it */
export async function closedClient(scheme: Scheme): Promise<unknown> {
	const client = createClient({ url: `${scheme}://127.0.0.1:1` })
	client.close()
	return client.execute("SELECT 1").then(
		() => new Error("the query did not fail"),
		(error: unknown) => error,
	)
}
