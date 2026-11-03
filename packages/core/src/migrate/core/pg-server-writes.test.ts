import { describe, expect, it } from "vitest"
import type { Sql } from "./pg-replay-database.ts"
import {
	addWrites,
	CATALOGS,
	type Change,
	catalogsOf,
	counts,
	refusedChanges,
	refuseUncounted,
	rowChanges,
	subjectRows,
	writesSince,
} from "./pg-server-writes.ts"

/** A postgres.js stand-in answering each catalog read by the relation it reads, as `key`, `row` and `names` */
function server(catalogs: Record<string, Array<[string, Record<string, unknown>, string[]?]>>): Sql {
	return {
		end: async () => undefined,
		unsafe: async (query: string) => {
			const [, rows = []] = Object.entries(catalogs).find(([name]) => query.includes(` FROM ${name} `)) ?? []
			return rows.map(([key, row, names = [key]]) => ({ key, names, row }))
		},
	}
}

/** What the replay refuses of the `counted` writes, reading through the catalogs a superuser or not reads */
const named = async (
	{ own, sql, superuser = false, was }: { own: (change: Change) => boolean; sql: Sql; superuser?: boolean; was: Sql },
	counted: Map<string, number>,
	ours: Map<string, string>,
): Promise<string[]> =>
	refusedChanges(await rowChanges({ catalogs: catalogsOf(superuser), sql, was }, counted, ours), own)

/** A connection answering the counts read with `row` */
const countsOf = (row?: Record<string, unknown>) => ({
	end: async () => undefined,
	unsafe: async () => (row === undefined ? [] : [row]),
})

describe("counts, writesSince and addWrites", () => {
	it("reads track_counts and each catalog's writes in one row, takes only what grew since, and adds them up", async () => {
		const { on, writes } = await counts(countsOf({ on: "on", writes: { pg_authid: "2", pg_database: 0 } }))
		expect({ on, writes }).toEqual({
			on: true,
			writes: new Map([
				["pg_authid", 2],
				["pg_database", 0],
			]),
		})
		/* a count that fell, as after a flush, is no write */
		expect(writesSince(writes, new Map([["pg_authid", 3]]))).toEqual(new Map())
		expect(writesSince(writes, new Map([["pg_authid", 1]]))).toEqual(new Map([["pg_authid", 1]]))
		expect(writesSince(writes, new Map())).toEqual(new Map([["pg_authid", 2]]))
		addWrites(writes, new Map([["pg_tablespace", 1]]))
		addWrites(writes, new Map([["pg_authid", 1]]))
		expect(writes.get("pg_authid")).toBe(3)
		expect(writes.get("pg_tablespace")).toBe(1)
	})

	it("reads track_counts off, and no row as off with no writes", async () => {
		expect(await counts(countsOf({ on: "off", writes: {} }))).toEqual({ on: false, writes: new Map() })
		expect(await counts(countsOf())).toEqual({ on: false, writes: new Map() })
		await expect(refuseUncounted(countsOf({ on: "off", writes: {} }), "check stops")).rejects.toThrow(
			/track_counts is off.*; check stops$/,
		)
		await expect(refuseUncounted(countsOf({ on: "on", writes: {} }), "check stops")).resolves.toBeUndefined()
	})
})

/* no change is the replay's own */
const none = (): boolean => false

/* the replay owns kept's connection limit */
const own = ({ fields, subject }: Change): boolean => subject === "role kept" && fields.includes("rolconnlimit")

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
		expect(await named({ own: none, sql, was }, counted, ours)).toEqual([
			"role gone removed",
			"role kept changed (rolconnlimit)",
			"role new added",
			"pg_database, in a row devUrl's role cannot read",
			"pg_future, in a row devUrl's role cannot read",
		])
		/* a role's write pg_roles does not show, such as a password */
		expect(await named({ own: none, sql: was, was }, new Map([["pg_authid", 1]]), new Map())).toEqual([
			"pg_authid, in a column pg_roles does not show, such as a password",
		])
	})
})

/* P3 of r22: a change to the replay's own database is no other's, and a catalog with only those counted none */
describe("refusedChanges of the replay's own", () => {
	it("leaves out a change the replay owns, by subject and fields, naming the rest", async () => {
		const was = server({
			pg_roles: [
				["kept", { rolconnlimit: -1 }],
				["other", { rolconnlimit: -1 }],
			],
		})
		const counted = new Map([["pg_authid", 1]])
		const changed = (other: number) =>
			server({
				pg_roles: [
					["kept", { rolconnlimit: 5 }],
					["other", { rolconnlimit: other }],
				],
			})
		expect(await named({ own, sql: changed(-1), was }, counted, new Map())).toEqual([])
		expect(await named({ own, sql: changed(3), was }, counted, new Map())).toEqual([
			"role other changed (rolconnlimit)",
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
		expect(await subjectRows({ catalogs: CATALOGS, sql }, written, (subject) => subject === "role mine")).toEqual(
			new Map([["role mine", JSON.stringify({ rolconnlimit: -1 })]]),
		)
	})
})

/* P5 of r22: a superuser reads pg_authid itself, so a password change is a row it names, and a change carries the names it is about */
describe("rowChanges read as a superuser", () => {
	it("names a pg_authid change a non-superuser reads as unseen, with the names each change is about", async () => {
		const was = server({ pg_authid: [["kept", { rolpassword: "a1" }]] })
		const sql = server({
			pg_authid: [
				["kept", { rolpassword: "b2" }],
				["made", { rolpassword: "c3" }],
			],
		})
		const counted = new Map([["pg_authid", 2]])
		expect(await named({ own: none, sql, superuser: true, was }, counted, new Map())).toEqual([
			"role kept changed (rolpassword)",
			"role made added",
		])
		const changes = await rowChanges({ catalogs: catalogsOf(true), sql, was }, counted, new Map())
		expect(changes.get("pg_authid")?.map(({ kind, names }) => [kind, names])).toEqual([
			["changed", ["kept"]],
			["added", ["made"]],
		])
		expect(await named({ own: none, sql, was }, counted, new Map())).toEqual([
			"pg_authid, in a column pg_roles does not show, such as a password",
		])
	})
})

/* a shared server: another session commits while the replay reads, between the committed read and its transaction's own */
describe("rowChanges beside another session's commit", () => {
	it("names no change another session committed between the reads, and still names the file's own", async () => {
		const reads = [
			[
				["other", { rolconnlimit: -1 }],
				["kept", { rolconnlimit: -1 }],
			],
			[["kept", { rolconnlimit: -1 }]],
		] as Array<Array<[string, Record<string, unknown>]>>
		/* the committed server: `other` there at the first read, dropped by its session before the second */
		const was: Sql = {
			end: async () => undefined,
			unsafe: async () => (reads.shift() ?? []).map(([key, row]) => ({ key, names: [key], row })),
		}
		const sql = server({ pg_roles: [["kept", { rolconnlimit: 5 }]] })
		expect(await named({ own: none, sql, was }, new Map([["pg_authid", 1]]), new Map())).toEqual([
			"role kept changed (rolconnlimit)",
		])
	})
})
