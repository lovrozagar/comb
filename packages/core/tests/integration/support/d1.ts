/** Cloudflare D1 and KV in process, on Miniflare's workerd: the bindings a Worker sees. */
import type { D1Database, KVNamespace } from "@cloudflare/workers-types"
import { Miniflare } from "miniflare"

export type D1Harness = {
	CORE: D1Database
	KV: KVNamespace
	dispose(): Promise<void>
}

/* Miniflare needs a Worker to host the bindings; this one never serves a request */
const WORKER = "export default { fetch() { return new Response(null, { status: 204 }) } }"

/** A fresh in-memory D1 database bound as `CORE` and a KV namespace bound as `KV`. */
export async function d1Memory(): Promise<D1Harness> {
	const mf = new Miniflare({ d1Databases: ["CORE"], kvNamespaces: ["KV"], modules: true, script: WORKER })
	const [core, kv] = await Promise.all([mf.getD1Database("CORE"), mf.getKVNamespace("KV")])
	return {
		/* Miniflare types its bindings with its own copy of workers-types; the runtime objects are the same */
		CORE: core as unknown as D1Database,
		KV: kv as unknown as KVNamespace,
		dispose: () => mf.dispose(),
	}
}
