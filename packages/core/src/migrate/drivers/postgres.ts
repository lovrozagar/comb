/**
 * PostgreSQL driver implementations (Neon, Supabase, plain pg)
 *
 * TODO: Implement when needed. Interface is defined, implementation pending.
 */
import type {
	Connection,
	ConnectionProvider,
	NeonProviderConfig,
	PostgresProviderConfig,
	ResolvedDatabaseConfig,
} from "../types.ts"

/* ═══════════════════════════════════════════════════════════════════════════
   POSTGRES PROVIDER (not yet implemented)
   ═══════════════════════════════════════════════════════════════════════════ */

export function createPostgresProvider(_config: PostgresProviderConfig): ConnectionProvider {
	return {
		connect(_dbConfig: ResolvedDatabaseConfig): Promise<Connection> {
			throw new Error("Postgres provider not yet implemented. Use @neondatabase/serverless or pg.")
		},
		dialect: "postgres",
	}
}

/* ═══════════════════════════════════════════════════════════════════════════
   NEON PROVIDER (not yet implemented)
   ═══════════════════════════════════════════════════════════════════════════ */

export function createNeonProvider(_config: NeonProviderConfig): ConnectionProvider {
	return {
		connect(_dbConfig: ResolvedDatabaseConfig): Promise<Connection> {
			throw new Error("Neon provider not yet implemented. Install @neondatabase/serverless.")
		},
		dialect: "postgres",
	}
}

/* ═══════════════════════════════════════════════════════════════════════════
   POSTGRES SCHEMA INTROSPECTION (not yet implemented)
   ═══════════════════════════════════════════════════════════════════════════ */

export function introspectPostgresSchema(_conn: Connection): Promise<string> {
	throw new Error("Postgres introspection not yet implemented")
}

export async function getPostgresTables(conn: Connection): Promise<string[]> {
	const result = await conn.execute(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
      AND table_name != '__drizzle_migrations'
  `)
	return result.rows.map((row) => row[0] as string)
}

export async function getPostgresColumns(conn: Connection, table: string): Promise<string[]> {
	const result = await conn.execute(
		`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = $1
    ORDER BY ordinal_position
  `,
		[table],
	)
	return result.rows.map((row) => row[0] as string)
}

export async function getPostgresIndexes(conn: Connection): Promise<string[]> {
	const result = await conn.execute(`
    SELECT indexname FROM pg_indexes
    WHERE schemaname = 'public'
  `)
	return result.rows.map((row) => row[0] as string)
}
