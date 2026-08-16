import { describe, expect, it } from "vitest"
import {
	createNeonProvider,
	createPostgresProvider,
	getPostgresColumns,
	getPostgresIndexes,
	getPostgresTables,
	introspectPostgresSchema,
} from "../../../../src/migrate/drivers/postgres.ts"
import type { Connection, ResolvedDatabaseConfig } from "../../../../src/migrate/types.ts"

const dummyDbConfig: ResolvedDatabaseConfig = {
	migrationsDir: "/tmp",
	name: "test",
	provider: { connectionString: "postgres://localhost", type: "postgres" },
}

describe("createPostgresProvider", () => {
	it("returns provider with postgres dialect", () => {
		const provider = createPostgresProvider({
			connectionString: "postgres://localhost",
			type: "postgres",
		})
		expect(provider.dialect).toBe("postgres")
	})

	it("throws on connect (not yet implemented)", () => {
		const provider = createPostgresProvider({
			connectionString: "postgres://localhost",
			type: "postgres",
		})
		expect(() => provider.connect(dummyDbConfig)).toThrow("not yet implemented")
	})
})

describe("createNeonProvider", () => {
	it("returns provider with postgres dialect", () => {
		const provider = createNeonProvider({ connectionString: "postgres://neon", type: "neon" })
		expect(provider.dialect).toBe("postgres")
	})

	it("throws on connect (not yet implemented)", () => {
		const provider = createNeonProvider({ connectionString: "postgres://neon", type: "neon" })
		expect(() => provider.connect(dummyDbConfig)).toThrow("not yet implemented")
	})
})

describe("introspectPostgresSchema", () => {
	it("throws (not yet implemented)", () => {
		const conn = {} as Connection
		expect(() => introspectPostgresSchema(conn)).toThrow("not yet implemented")
	})
})

describe("getPostgresTables", () => {
	it("queries information_schema.tables", async () => {
		const conn: Connection = {
			batch: () => Promise.resolve(),
			close: () => Promise.resolve(),
			dialect: "postgres",
			execute: () =>
				Promise.resolve({
					columns: ["table_name"],
					rows: [["users"], ["posts"]],
				}),
		}
		const tables = await getPostgresTables(conn)
		expect(tables).toEqual(["users", "posts"])
	})
})

describe("getPostgresColumns", () => {
	it("queries information_schema.columns for a table", async () => {
		const conn: Connection = {
			batch: () => Promise.resolve(),
			close: () => Promise.resolve(),
			dialect: "postgres",
			execute: () =>
				Promise.resolve({
					columns: ["column_name"],
					rows: [["id"], ["email"], ["name"]],
				}),
		}
		const columns = await getPostgresColumns(conn, "users")
		expect(columns).toEqual(["id", "email", "name"])
	})
})

describe("getPostgresIndexes", () => {
	it("queries pg_indexes", async () => {
		const conn: Connection = {
			batch: () => Promise.resolve(),
			close: () => Promise.resolve(),
			dialect: "postgres",
			execute: () =>
				Promise.resolve({
					columns: ["indexname"],
					rows: [["idx_users_email"]],
				}),
		}
		const indexes = await getPostgresIndexes(conn)
		expect(indexes).toEqual(["idx_users_email"])
	})
})
