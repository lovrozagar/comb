/**
 * AA12 of r22: a plain inet or cidr column's create DTO takes an IPv6 address or network as the
 * server's own inet and cidr read it, held over a seeded corpus of groups, `::`s, IPv4 tails, zone ids
 * and prefixes, near-valid ones bent by one part. Each verdict is Postgres's, read with
 * pg_input_is_valid. The DTO never takes what Postgres refuses, and refuses what it takes only for
 * two spellings the 0.21 changelog lists: a colon before the prefix (`1::f:/64`) and an IPv4 tail
 * with an empty part (`::.255`, `::1..2`).
 */
import { afterAll, describe, expect, it } from "vitest"
import { cleanGeneratedDtos, generatedDtos } from "../support/dtos.ts"
import { usePg } from "../support/pg.ts"

afterAll(() => cleanGeneratedDtos())

/** mulberry32: a corpus the same on every run */
function random(seed: number): (n: number) => number {
	let state = seed
	return (n) => {
		state = (state + 0x6d2b79f5) | 0
		let t = Math.imul(state ^ (state >>> 15), 1 | state)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n)
	}
}

const HEXES = ["0", "1", "f", "F", "ab", "abc", "ffff", "0000", "00001", "12345", "g", ""]
const OCTETS = ["0", "1", "9", "10", "99", "100", "199", "249", "250", "255", "256", "300", "01", "001", "00", ""]
const PREFIXES = ["/0", "/1", "/64", "/96", "/120", "/127", "/128", "/129", "/00", "/064", "/1.5", "/", "/-1"]

/** IPv6-shaped values: random groups and tails, and near-valid addresses with one part bent */
function corpus(): string[] {
	const rand = random(7)
	const pick = <T>(items: readonly T[]): T => items[rand(items.length)] as T
	const group = (): string => pick(["0", "1", "ab", "fff", "ffff", "FFFF", "0001"])
	const loose = (): string => {
		const groups = Array.from({ length: rand(10) }, () => pick(HEXES))
		for (const odds of [3, 9]) if (rand(odds) === 0) groups.splice(rand(groups.length + 1), 0, "")
		const tail = rand(3) === 0 ? Array.from({ length: 1 + rand(5) }, () => pick(OCTETS)).join(".") : ""
		const text = [groups.join(":"), tail].filter((part) => part !== "").join(":")
		return rand(12) === 0 ? `${text}%eth0` : text
	}
	const near = (): string => {
		const left = rand(8)
		const right = Array.from({ length: rand(8 - left) }, group)
		if (rand(2) === 0)
			right.push(Array.from({ length: 2 + rand(3) }, () => pick(["0", "1", "12", "199", "255"])).join("."))
		const head = Array.from({ length: left }, group)
		const text = rand(4) === 0 ? [...head, ...right].join(":") : `${head.join(":")}::${right.join(":")}`
		return rand(6) === 0
			? text.replace(/[0-9a-f]/i, (char) => pick(["g", "00000", "", char.repeat(5), "256", "01"]))
			: text
	}
	const values = new Set<string>()
	for (let i = 0; i < 30_000; i++) values.add(rand(2) === 0 ? near() : loose())
	for (const value of [...values].slice(0, 4000)) for (const prefix of PREFIXES) values.add(value + prefix)
	return [...values].filter((value) => value.includes(":"))
}

/* the two spellings Postgres takes that the DTO refuses for the canonical one, as the changelog lists them */
const LISTED = (value: string): boolean => /:\//u.test(value) || /(?:^|:)\.|\.\./u.test(value)

describe("a plain inet and cidr column's IPv6 values, held to Postgres's own (AA12 of r22)", () => {
	const sessions = usePg()

	it("takes what Postgres's inet and cidr take, and nothing they refuse", async () => {
		const dtos = await generatedDtos(
			"pg-ip",
			`import { cidr, inet } from "drizzle-orm/pg-core"
export const host = pgTable("host", { id: c.id("hst"), ip: inet("ip"), net: cidr("net") })`,
			{ dialect: "postgres" },
		)
		const create = dtos["host"]?.["hostDtoCreateSchema"]
		const values = corpus()
		const { rows } = await sessions
			.pg()
			.query<{ v: string; inet: boolean; cidr: boolean }>(
				"SELECT v, pg_input_is_valid(v, 'inet') AS inet, pg_input_is_valid(v, 'cidr') AS cidr FROM unnest($1::text[]) AS v",
				[values],
			)
		const apart: string[] = []
		let taken = 0
		for (const { v, inet, cidr } of rows)
			for (const [key, postgres] of [
				["ip", inet],
				["net", cidr],
			] as const) {
				const dto = create?.safeParse({ [key]: v }).success
				if (postgres) taken++
				if (dto !== postgres && !(postgres && !dto && LISTED(v)))
					apart.push(`${key} ${JSON.stringify(v)}: DTO ${dto}, Postgres ${postgres}`)
			}
		expect(apart).toEqual([])
		/* the corpus reaches what it holds: tens of thousands of values, thousands of them Postgres takes */
		expect(rows.length).toBeGreaterThan(50_000)
		expect(taken).toBeGreaterThan(10_000)
	}, 240_000)
})
