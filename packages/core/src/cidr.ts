/**
 * Whether a network is one Postgres's `cidr` takes: an IPv4 or IPv6 address, with or without a
 * prefix length, and no bit set past that length ('192.168.0.1/24' is refused, '192.168.0.0/24'
 * is taken). Generated write DTOs import it for a `cidr` column, so the rule has one source (F50).
 */

/** An IPv4 address's 32 bits, or null when it is no dotted-quad of decimal octets */
function ipv4Bits(address: string): string | null {
	const octets = address.split(".")
	if (octets.length !== 4 || !octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)) return null
	return octets.map((octet) => Number(octet).toString(2).padStart(8, "0")).join("")
}

/** An IPv6 group's 16 bits, or null when it is no group of one to four hex digits */
const groupBits = (group: string): string | null =>
	/^[\da-f]{1,4}$/i.test(group) ? Number.parseInt(group, 16).toString(2).padStart(16, "0") : null

/** The bits of `:`-separated IPv6 groups, an IPv4 address last counting as two; null when any is malformed */
function groupsBits(part: string): string | null {
	if (part === "") return ""
	const groups = part.split(":")
	const last = groups.at(-1) as string
	const tail = last.includes(".") ? ipv4Bits(last) : ""
	const bits = (tail === "" ? groups : groups.slice(0, -1)).map(groupBits)
	return tail === null || bits.includes(null) ? null : bits.join("") + tail
}

/** An IPv6 address's 128 bits, its `::` filled with zero groups, or null when it is none */
function ipv6Bits(address: string): string | null {
	const halves = address.split("::")
	if (halves.length > 2) return null
	/* an IPv4 tail ends the address, so none stands before a `::` */
	if (halves.length === 2 && (halves[0] as string).includes(".")) return null
	const [head, tail] = halves.map(groupsBits)
	if (head === null || tail === null || head === undefined) return null
	if (tail === undefined) return head.length === 128 ? head : null
	const filled = 128 - head.length - tail.length
	return filled > 0 ? head + "0".repeat(filled) + tail : null
}

/** Whether `value` is a network Postgres's `cidr` takes, with no bit set past its prefix length */
export function isCidr(value: string): boolean {
	const [address, prefix, extra] = value.split("/") as [string, string | undefined, string | undefined]
	if (extra !== undefined) return false
	const bits = address.includes(":") ? ipv6Bits(address) : ipv4Bits(address)
	if (bits === null) return false
	if (prefix === undefined) return true
	if (!/^\d{1,3}$/.test(prefix) || Number(prefix) > bits.length) return false
	return !bits.slice(Number(prefix)).includes("1")
}
