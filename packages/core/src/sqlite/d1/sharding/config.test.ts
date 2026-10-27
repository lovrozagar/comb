/* U39: a setting the router cannot run on is refused when it is built, not reported later as capacity or a silent cache miss */
import { describe, expect, it } from "vitest"
import { ShardRouter } from "./router.ts"

describe("ShardRouter: the settings it is built with", () => {
	it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("refuses totalShards %s", (totalShards) => {
		expect(() => new ShardRouter({ totalShards })).toThrow(
			new RangeError(`totalShards must be a positive integer, got ${totalShards}`),
		)
	})

	it.each([0, -1, 2.5, Number.NaN])("refuses maxOrgsPerShard %s, given or not a pick", (maxOrgsPerShard) => {
		const error = new RangeError(`maxOrgsPerShard must be a positive integer, got ${maxOrgsPerShard}`)
		expect(() => new ShardRouter({ maxOrgsPerShard, totalShards: 2 })).toThrow(error)
		expect(() => new ShardRouter({ maxOrgsPerShard, pick: () => 0, totalShards: 2 })).toThrow(error)
	})

	it.each([30, 59, 60.5, Number.NaN])(
		"refuses kvTtlSeconds %s, under KV's 60-second floor or no whole second",
		(kvTtlSeconds) => {
			expect(() => new ShardRouter({ kvTtlSeconds, totalShards: 2 })).toThrow(
				new RangeError(`kvTtlSeconds must be an integer of at least 60, KV's floor, got ${kvTtlSeconds}`),
			)
		},
	)

	it("takes whole settings, and the defaults", () => {
		expect(() => new ShardRouter({ kvTtlSeconds: 60, maxOrgsPerShard: 1, totalShards: 1 })).not.toThrow()
		expect(() => new ShardRouter({ totalShards: 3 })).not.toThrow()
	})
})
