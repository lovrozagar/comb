/**
 * The surface of @libsql/client comb calls, declared here: the client is an optional peer, loaded by
 * a string-typed specifier, so a project without it still type-checks /migrate (K2 of r17), and
 * through optionalPeer, so a project that needs it and lacks it is told the package and its range.
 */
import { optionalPeer } from "../core/optional-peer.ts"
import { LIBSQL } from "../core/peer-needs.ts"

type InValue = ArrayBuffer | bigint | boolean | Date | null | number | string | Uint8Array
type Statement = { args: InValue[]; sql: string }
type Client = {
	/** `"write"` begins the batch IMMEDIATE, where the default begins it DEFERRED */
	batch(statements: Statement[], mode: "write"): Promise<unknown>
	close(): void
	execute(statement: Statement): Promise<{ columns: string[]; rows: Array<Record<string, unknown>> }>
}
type LibsqlModule = { createClient(config: { authToken?: string | undefined; url: string }): Client }
const LIBSQL_CLIENT: string = "@libsql/client"

/** @libsql/client, loaded when a libsql or Turso connection opens */
const libsql = (): Promise<LibsqlModule> => optionalPeer(LIBSQL, () => import(LIBSQL_CLIENT) as Promise<LibsqlModule>)

export { type Client, type InValue, libsql, LIBSQL_CLIENT }
