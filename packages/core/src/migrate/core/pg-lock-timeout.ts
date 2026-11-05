/** A Postgres target's lockTimeout, read once as Postgres reads lock_timeout */

// lookup-table: each unit of a Postgres time setting, in milliseconds
const UNIT_MS: Readonly<Record<string, number>> = {
	d: 86_400_000,
	h: 3_600_000,
	min: 60_000,
	ms: 1,
	s: 1000,
	us: 0.001,
}

/* the longest lock_timeout Postgres takes: an int of milliseconds */
const INT_MAX = 2_147_483_647

/** `value` rounded as Postgres's rint rounds a setting: to the nearest whole, half to even */
const halfEven = (value: number): number => {
	const floor = Math.floor(value)
	const rest = value - floor
	return rest > 0.5 || (rest === 0.5 && floor % 2 === 1) ? floor + 1 : floor
}

/**
 * `lockTimeout` in whole milliseconds, as Postgres reads lock_timeout: a number, an
 * optional space and an optional unit (milliseconds when none), rounded half to even; or why it is
 * none Postgres takes. Read once, so what Atlas is handed is the same value written with no space.
 */
function lockTimeoutMs(text: string): number | string {
	const [, digits, unit] = /^(\d+(?:\.\d+)?) ?(us|ms|s|min|h|d)?$/.exec(text) ?? []
	if (digits === undefined)
		return "lockTimeout must be a Postgres duration: a number of milliseconds (250, 0 for none), or a number with us, ms, s, min, h or d (1500ms, 1.5s, 1min)"
	const ms = halfEven(Number(digits) * (UNIT_MS[unit ?? "ms"] as number))
	if (ms > INT_MAX)
		return `lockTimeout ${text} is longer than Postgres's lock_timeout takes: at most ${INT_MAX}ms (about 24.8 days)`
	if (ms === 0 && Number(digits) !== 0)
		return `lockTimeout ${text} rounds to 0ms, which turns lock_timeout off; give at least 1ms, or 0 for none`
	return ms
}

export { lockTimeoutMs }
