/**
 * The SQLite, libsql or Turso database comb.migrate.config.ts resolved, opened for a migrate command:
 * read-only for check and status, which refuse a missing database. An apply or baseline checks on a
 * read-only connection too, a missing database read as the empty one it is, and opens the writable
 * connection only to write, so a refused run creates no file and no Turso database, and mints no
 * full-access token (S6 of the 0.15.0 review, S3 of r18). Each file applies on a connection of its
 * own, so its connection settings end with it (S1 of r21).
 */
import fs from "node:fs"
import { blank } from "../blank.ts"
import { absentDatabase } from "../migrate/drivers/absent.ts"
import { DatabaseMissing } from "../migrate/drivers/missing.ts"
import type { Connection, ConnectionProviderConfig } from "../migrate/types.ts"
import type { ParsedArgs } from "./args.ts"
import type { MigrateTarget } from "./migrate-target.ts"
import { CliError, type CliIo } from "./output.ts"

/** An open database to migrate: the connection its checks read, the one its writes go to, and how to name it */
export type SqliteTarget = {
	close(): Promise<void>
	conn: Connection
	migrationsDir: string
	name: string
	/** the connection to write comb's history through, opened on first use */
	write(): Promise<Connection>
	/** a new connection for one file's apply, which the caller closes; an in-memory database's is its writer, which only the target closes */
	fresh(): Promise<Connection>
}

type OpenRequest = { args: ParsedArgs; io: CliIo; mode: string }

/** The database read-only, or the empty database a missing one is */
async function readOrAbsent(connect: (readonly: boolean) => Promise<Connection>, name: string): Promise<Connection> {
	try {
		return await connect(true)
	} catch (error) {
		if (error instanceof DatabaseMissing) return absentDatabase(name)
		throw error
	}
}

/** Whether the database lives in the one connection that opened it, so no other connection reaches it */
async function inMemory(provider: ConnectionProviderConfig): Promise<boolean> {
	if (provider.type === "bun-sqlite") return provider.path === ":memory:"
	const { libsqlFile } = await import("../migrate/drivers/sqlite.ts")
	return provider.type === "libsql" && (provider.url === ":memory:" || libsqlFile(provider.url) === ":memory:")
}

/** Why the provider cannot connect as given: a libsql url or a turso apiToken left blank, which loads (P9 of r18, S5 of r19) */
function emptyCredential(provider: ConnectionProviderConfig): string | undefined {
	if (provider.type === "libsql" && blank(provider.url))
		return "url is empty: set the libsql provider's url for this database"
	if (provider.type === "turso" && blank(provider.apiToken))
		return "apiToken is empty: set the turso provider's apiToken for this database"
	return undefined
}

/** `target` opened for `request.mode`; refuses the flags only a D1 database takes */
export async function openSqliteTarget(
	{ args, io, mode }: OpenRequest,
	target: MigrateTarget & { provider: ConnectionProviderConfig },
): Promise<SqliteTarget> {
	if (args.options["local"]) throw new CliError("--local is for a D1 database; set local: true on its d1 provider")
	if (args.options["hashes"])
		throw new CliError(
			"--hashes is for a D1 database, whose history records names alone: this one records each file's hash as it applies it",
		)
	const empty = emptyCredential(target.provider)
	if (empty !== undefined) throw new CliError(empty)
	if (args.options["file"] === undefined && !fs.existsSync(target.migrationsDir))
		throw new CliError(`Migrations dir not found: ${target.migrationsDir}`)
	const { createProvider } = await import("../migrate/config.ts")
	const { drizzleConfigPath, migrationsDir, name, provider } = target
	/* one provider for the command: a Turso one mints its token once, however many connections it opens */
	const opener = createProvider(provider, { run: io.run })
	const connect = (readonly: boolean) => opener.connect({ drizzleConfigPath, migrationsDir, name, provider, readonly })
	if (mode === "check" || mode === "status") {
		const conn = await connect(true)
		const same = () => Promise.resolve(conn)
		return { close: () => conn.close(), conn, fresh: same, migrationsDir, name: target.label, write: same }
	}
	const conn = await readOrAbsent(connect, target.label)
	let writer: Connection | undefined
	const write = async () => (writer ??= await connect(false))
	return {
		close: async () => {
			await conn.close()
			await writer?.close()
		},
		conn,
		fresh: (await inMemory(provider))
			? async () => ({ ...(await write()), close: () => Promise.resolve() })
			: () => connect(false),
		migrationsDir,
		name: target.label,
		write,
	}
}
