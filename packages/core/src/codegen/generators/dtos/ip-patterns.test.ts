import { RE2JS } from "re2js"
import { describe, expect, it } from "vitest"
import * as z from "zod"
import { cidrv6Rule, inetRule, ipv6Rule } from "./ip-patterns.ts"

/** The schema a rule's code evaluates to, as the generated DTO evaluates it */
const schemaOf = (code: string): z.ZodType => new Function("z", `return ${code}`)(z) as z.ZodType

/** The pattern a rule publishes */
const patternOf = (code: string): string => (z.toJSONSchema(schemaOf(code)) as { pattern: string }).pattern

/*
 * AA12 of r22: each verdict is Postgres 17's own for the value cast to inet, an IPv6 one; the
 * integration suite holds the rule to the server over a wider corpus
 */
const ADDRESSES: Array<[value: string, postgres: boolean]> = [
	["::", true],
	["::1", true],
	["1:2:3:4:5:6:7:8", true],
	["2001:DB8::ABCD", true],
	["0001:0002::0003", true],
	["::0000", true],
	["1:2:3:4:5:6:7::", true],
	["::1:2:3:4:5:6:7", true],
	["::ffff:1.2.3.4", true],
	["64:ff9b::1.2.3.4", true],
	["1::1.2.3.4", true],
	["1:2:3:4:5:6:1.2.3.4", true],
	["::ffff:0.0.0.0", true],
	["::ffff:255.255.255.255", true],
	["::ffff:1.2.3", true],
	["::ffff:1.2", true],
	["1:2:3:4:5:6:1.2", true],
	["::ffff:256.1.1.1", false],
	["::ffff:1.2.3.999", false],
	["::ffff:01.2.3.4", false],
	["::ffff:1.2.3.04", false],
	["::ffff:1.2.3.4.5", false],
	["::ffff:1.2.", false],
	["1:2:3:4:5:6:7:1.2.3.4", false],
	["1:2:3:4:5:6:7:1.2", false],
	["1:2:3:4:5:6::1.2.3.4", false],
	["::1.2.3.4:1", false],
	["::a.2.3.4", false],
	["1.2.3.4::", false],
	["fe80::1%eth0", false],
	["00001::", false],
	["12345::", false],
	[":::", false],
	["1:::2", false],
	["1::2::3", false],
	["1:", false],
	[":1", false],
	["1:2:3:4:5:6:7:8:9", false],
	["1:2:3:4::5:6:7:8", false],
	["::1:2:3:4:5:6:7:8", false],
	[" ::1", false],
	["[::1]", false],
	["g::1", false],
]

/* Postgres 17's verdict for the value cast to inet, a network: its prefix 0 to 128, with no leading zero */
const NETWORKS: Array<[value: string, postgres: boolean]> = [
	["::/0", true],
	["::1/128", true],
	["2001:db8::/64", true],
	["::ffff:1.2.3.0/120", true],
	["::ffff:1.2.3/120", true],
	["1:2:3:4:5:6:7:8/1", true],
	["::/129", false],
	["::/00", false],
	["::/064", false],
	["::/-1", false],
	["::/", false],
	["::/1.5", false],
	["::/ 64", false],
	["fe80::%eth0/64", false],
]

describe("comb's IPv6 rules, as Postgres reads an address (AA12 of r22)", () => {
	it.each(ADDRESSES)("ipv6 %j: Postgres %s", (value, postgres) => {
		expect(schemaOf(ipv6Rule()).safeParse(value).success).toBe(postgres)
		expect(schemaOf(cidrv6Rule()).safeParse(`${value}/64`).success).toBe(postgres)
	})

	it.each(NETWORKS)("cidrv6 %j: Postgres %s", (value, postgres) => {
		expect(schemaOf(cidrv6Rule()).safeParse(value).success).toBe(postgres)
		expect(schemaOf(inetRule()).safeParse(value).success).toBe(postgres)
	})

	it("publishes the regex it runs, under RE2 too, with no shorthand class", () => {
		for (const code of [ipv6Rule(), cidrv6Rule()]) {
			const pattern = patternOf(code)
			const re2 = RE2JS.compile(pattern)
			for (const [value] of [...ADDRESSES, ...NETWORKS])
				expect(new RegExp(pattern, "u").test(value) === re2.matches(value)).toBe(true)
			expect(pattern).not.toMatch(/(?<!\\)(?:\\\\)*\\[bBdDsSwW]/u)
		}
	})

	it("keeps zod's format and its issue: the same code, format and message", () => {
		expect(z.toJSONSchema(schemaOf(ipv6Rule()))).toMatchObject({ format: "ipv6", type: "string" })
		expect(z.toJSONSchema(schemaOf(cidrv6Rule()))).toMatchObject({ format: "cidrv6", type: "string" })
		expect(schemaOf(ipv6Rule()).safeParse("g::1").error?.issues).toEqual(z.ipv6().safeParse("g::1").error?.issues)
		expect(schemaOf(cidrv6Rule()).safeParse("::/129").error?.issues).toEqual(
			z.cidrv6().safeParse("::/129").error?.issues,
		)
	})
})
