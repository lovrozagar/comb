import { describe, expect, it } from "vitest"
import { isCidr } from "./cidr.ts"

/* each verdict is Postgres 17's own for the value cast to cidr, but for the abbreviations last, which it reads as a network */
describe("isCidr", () => {
	it.each([
		"192.168.0.0/24",
		"10.0.0.0/8",
		"0.0.0.0/0",
		"192.168.0.1",
		"192.168.0.1/32",
		"2001:db8::/32",
		"fe80::/64",
		"::/0",
		"::1",
		"::1/128",
		"1:2:3:4:5:6:7:8/128",
		"::ffff:192.168.0.0/120",
		"1:2:3:4:5:6:1.2.3.4",
	])("takes %s", (value) => {
		expect(isCidr(value)).toBe(true)
	})

	it.each([
		/* a bit set past the prefix length */
		"192.168.0.1/24",
		"10.0.0.1/8",
		"fe80::1/64",
		"2001:db8::1/32",
		"::ffff:192.168.0.1/120",
		/* a prefix past the address, or no number */
		"192.168.0.0/33",
		"::/129",
		"10.0.0.0/x",
		"10.0.0.0/8/8",
		/* no address */
		"300.1.1.1",
		"1:2:3:4:5:6:7",
		"1:2:3:4:5:6:7:8:9",
		"1::2::3",
		"1:2:3:4:5:6:7:8::",
		"1.2.3.4::",
		"g::1",
		/* stricter than Postgres, listed in the 0.14 changelog: an abbreviated address */
		"10.1",
		"::1.2.3",
	])("refuses %s", (value) => {
		expect(isCidr(value)).toBe(false)
	})
})
