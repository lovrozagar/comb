/**
 * The SQLite, libsql or Turso database comb.migrate.config.ts resolved, opened for a migrate command:
 * read-only for check and status. A Turso apply or baseline checks on a read-only connection too, a
 * missing database read as the empty one it is, and creates the database and mints a full-access
 * token only to write (S6 of the 0.15.0 review); another engine opens once, as the command needs.
 */
import fs from "node:fs"
import { absentDatabase } from "../migrate/drivers/absent.ts"
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
	/** the connection to write through, opened on first use */
	write(): Promise<Connection>
}

type OpenRequest = { args: ParsedArgs; io: CliIo; mode: string }

/** Turso's database read-only, or the empty database a missing one is */
async function readTurso(connect: (readonly: boolean) => Promise<Connection>, name: string): Promise<Connection> {
	try {
		return await connect(true)
	} catch (error) {
		const { TursoMissing } = await import("../migrate/drivers/sqlite.ts")
		if (error instanceof TursoMissing) return absentDatabase(name)
		throw error
	}
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
	if (args.options["file"] === undefined && !fs.existsSync(target.migrationsDir))
		throw new CliError(`Migrations dir not found: ${target.migrationsDir}`)
	const { createProvider } = await import("../migrate/config.ts")
	const { drizzleConfigPath, migrationsDir, name, provider } = target
	const connect = (readonly: boolean) =>
		createProvider(provider, { run: io.run }).connect({ drizzleConfigPath, migrationsDir, name, provider, readonly })
	const reads = mode === "check" || mode === "status"
	if (reads || provider.type !== "turso") {
		const conn = await connect(reads)
		return { close: () => conn.close(), conn, migrationsDir, name: target.label, write: () => Promise.resolve(conn) }
	}
	const conn = await readTurso(connect, target.label)
	let writer: Connection | undefined
	return {
		close: async () => {
			await conn.close()
			await writer?.close()
		},
		conn,
		migrationsDir,
		name: target.label,
		write: async () => (writer ??= await connect(false)),
	}
}
