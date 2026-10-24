import { describe, expect, it } from "vitest"
import { assertShard, headroomPick } from "./placement.ts"

describe("headroomPick", () => {
	it("takes the shard with the most headroom under the cap, the lowest on a tie, and none when all are full", () => {
		const pick = headroomPick(2)
		expect(pick({ counts: new Map([[0, 1]]), orgId: "o", totalShards: 3 })).toBe(1)
		expect(pick({ counts: new Map([[0, 2]]), orgId: "o", totalShards: 2 })).toBe(1)
		expect(pick({ counts: new Map(), orgId: "o", totalShards: 3 })).toBe(0)
		expect(
			pick({
				counts: new Map([
					[0, 2],
					[1, 3],
				]),
				orgId: "o",
				totalShards: 2,
			}),
		).toBeUndefined()
	})
})

describe("assertShard", () => {
	it("takes an integer from 0 below totalShards and throws a RangeError for any other", () => {
		expect(() => assertShard(0, 1)).not.toThrow()
		for (const shardId of [1, -1, 0.5, Number.NaN]) expect(() => assertShard(shardId, 1)).toThrow(RangeError)
	})
})
