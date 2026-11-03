/**
 * The SQLite, libsql or Turso database comb.migrate.config.ts resolved, opened for a migrate command:
 * read-only for check and status, which refuse a missing database. An apply or baseline checks on a
 * read-only connection too, a missing database read as the empty one it is, and opens the writable
 * connection only to write, so a refused run creates no file and no Turso database, and mints no
 * full-access token (S6 of the 0.15.0 review, S3 of r18). On a local file each file applies on a
 * connection of its own, so its connection settings end with it (S1 of r21), a libsql file's through
 * libsql's own Database, which lets go of the file when it closes (SL1 of r22); a libsql server (sqld,
 * Turso) refuses every connection setting at check, so its files apply through the one writer (S1 of r22).
 */
import fs from "node:fs"
import path from "node:path"
import { blank } from "../blank.ts"
import { absentDatabase } from "../migrate/drivers/absent.ts"
import { DatabaseMissing } from "../migrate/drivers/missing.ts"
import type { FileConnection } from "../migrate/core/apply.ts"
import type { TargetKind } from "../migrate/core/classify-target.ts"
import type { ScratchEngine } from "../migrate/drivers/local-db.ts"
import type { Connection, ConnectionProviderConfig } from "../migrate/types.ts"
import type { ParsedArgs } from "./args.ts"
import type { MigrateTarget } from "./migrate-target.ts"
import { CliError, type CliIo } from "./output.ts"

/** An open database to migrate: the connection its checks read, the one its writes go to, and how to name it */
export type SqliteTarget = {
	close(): Promise<void>
	conn: Connection
	/** the SQLite its files apply on, which their proof copy and a baseline's replay run on (SL3 of r22) */
	engine: ScratchEngine
	/** where the files apply: a SQLite file comb opens, or a libsql server */
	kind: Exclude<TargetKind, "d1">
	migrationsDir: string
	name: string
	/** the connection to write comb's history through, opened on first use */
	write(): Promise<Connection>
	/** the connection one file applies on, which the caller closes: a new one on a file; the writer, which only the target closes, on an in-memory database or a server */
	fresh(): Promise<FileConnection>
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

/** Where the database lives: `memory` in the one connection that opened it, a `file` comb opens, or a libsql `server` */
type Place = { at: "file"; file: string } | { at: "memory" | "server" }

async function placeOf(provider: ConnectionProviderConfig): Promise<Place> {
	if (provider.type === "bun-sqlite")
		return provider.path === ":memory:" ? { at: "memory" } : { at: "file", file: provider.path }
	if (provider.type !== "libsql") return { at: "server" }
	const { libsqlFile } = await import("../migrate/drivers/sqlite.ts")
	const file = provider.url === ":memory:" ? ":memory:" : libsqlFile(provider.url)
	if (file === undefined) return { at: "server" }
	return file === ":memory:" ? { at: "memory" } : { at: "file", file }
}

/** How each file's own connection opens on a `file`: a libsql file's through libsql's Database (SL1 of r22), bun:sqlite's as its provider opens it */
async function fileOpener(
	provider: ConnectionProviderConfig,
	file: string,
	connect: (readonly: boolean) => Promise<Connection>,
): Promise<() => Promise<FileConnection>> {
	if (provider.type !== "libsql") return () => connect(false)
	const { openLibsqlFile } = await import("../migrate/drivers/libsql-file.ts")
	return () => openLibsqlFile(file)
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
	const place = await placeOf(provider)
	const kind = place.at === "server" ? "sqld" : "local"
	const engine = provider.type === "bun-sqlite" ? "runtime" : "libsql"
	if (mode === "check" || mode === "status") {
		const conn = await connect(true)
		const same = () => Promise.resolve(conn)
		return {
			close: () => conn.close(),
			conn,
			engine,
			fresh: same,
			kind,
			migrationsDir,
			name: target.label,
			write: same,
		}
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
		engine,
		fresh:
			place.at === "file"
				? await fileOpener(provider, place.file, connect)
				: async () => ({ ...(await write()), close: () => Promise.resolve() }),
		kind,
		migrationsDir,
		name: target.label,
		write,
	}
}

/**
 * A --file's name: its path from the migrations directory, `../lone.sql` outside it; refused in a
 * subdirectory of it, which no whole-directory run reads (M34), and refused by name when it is
 * missing or no file (KC8 of r22b)
 */
export function fileName(single: string, { cwd, dir }: { cwd: string; dir: string }): string {
	const file = path.resolve(cwd, single)
	if (!fs.existsSync(file)) throw new CliError(`--file ${file} does not exist`)
	if (!fs.statSync(file).isFile()) throw new CliError(`--file ${file} is not a file`)
	const relative = path.relative(dir, file)
	if (!relative.startsWith("..") && relative.includes(path.sep))
		throw new CliError(
			`${single} is in a subdirectory of ${dir}, which a whole-directory run does not read; move it to the directory's top level, or outside it`,
		)
	return relative
}
