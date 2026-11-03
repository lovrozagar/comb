import { describe, expect, it } from "vitest"
import type { Sql } from "./pg-replay-database.ts"
import { addWrites, namedChanges, sharedWrites, subjectRows, writesSince } from "./pg-server-writes.ts"

/** A postgres.js stand-in answering each catalog read by the relation it reads, as `key` and `row` pairs */
function server(catalogs: Record<string, Array<[string, Record<string, unknown>]>>): Sql {
	return {
		end: async () => undefined,
		unsafe: async (query: string) => {
			const [, rows = []] = Object.entries(catalogs).find(([name]) => query.includes(` FROM ${name} `)) ?? []
			return rows.map(([key, row]) => ({ key, row }))
		},
	}
}

describe("sharedWrites, writesSince and addWrites", () => {
	it("reads each catalog's writes, takes only what grew since, and adds them up", async () => {
		const sql = {
			end: async () => undefined,
			unsafe: async () => [
				{ n: "2", relname: "pg_authid" },
				{ n: "0", relname: "pg_database" },
			],
		}
		const writes = await sharedWrites(sql)
		expect(writes).toEqual(
			new Map([
				["pg_authid", 2],
				["pg_database", 0],
			]),
		)
		/* a count that fell, as after a flush, is no write */
		expect(writesSince(writes, new Map([["pg_authid", 3]]))).toEqual(new Map())
		expect(writesSince(writes, new Map([["pg_authid", 1]]))).toEqual(new Map([["pg_authid", 1]]))
		expect(writesSince(writes, new Map())).toEqual(new Map([["pg_authid", 2]]))
		addWrites(writes, new Map([["pg_tablespace", 1]]))
		addWrites(writes, new Map([["pg_authid", 1]]))
		expect(writes.get("pg_authid")).toBe(3)
		expect(writes.get("pg_tablespace")).toBe(1)
	})
})

describe("namedChanges", () => {
	it("names each row added, removed or changed, leaves out comb's own, and names a write it cannot see", async () => {
		const was = server({
			pg_database: [["app", { datname: "app" }]],
			pg_roles: [
				["kept", { rolconnlimit: -1 }],
				["gone", { rolconnlimit: -1 }],
			],
		})
		const sql = server({
			pg_database: [["app", { datname: "app" }]],
			pg_roles: [
				["kept", { rolconnlimit: 5 }],
				["ours", { rolconnlimit: -1 }],
				["new", { rolconnlimit: -1 }],
			],
		})
		/* a shared catalog a later Postgres adds, which comb has no read of */
		const counted = new Map([
			["pg_future", 1],
			["pg_database", 1],
			["pg_authid", 3],
		])
		const ours = new Map([["role ours", JSON.stringify({ rolconnlimit: -1 })]])
		expect(await namedChanges({ sql, was }, counted, ours)).toEqual([
			"role gone removed",
			"role kept changed (rolconnlimit)",
			"role new added",
			"pg_database, in a row devUrl's role cannot read",
			"pg_future, in a row devUrl's role cannot read",
		])
		/* a role's write pg_roles does not show, such as a password */
		expect(await namedChanges({ sql: was, was }, new Map([["pg_authid", 1]]), new Map())).toEqual([
			"pg_authid, in a column pg_roles does not show, such as a password",
		])
	})
})

describe("subjectRows", () => {
	it("keeps the rows the subjects name, of the catalogs written, skipping one comb has no read of", async () => {
		const sql = server({
			pg_roles: [
				["mine", { rolconnlimit: -1 }],
				["other", { rolconnlimit: -1 }],
			],
		})
		const written = new Map([
			["pg_future", 1],
			["pg_authid", 1],
		])
		expect(await subjectRows(sql, written, (subject) => subject === "role mine")).toEqual(
			new Map([["role mine", JSON.stringify({ rolconnlimit: -1 })]]),
		)
	})
})
