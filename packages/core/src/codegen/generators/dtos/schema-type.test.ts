import { expect, it } from "vitest"
import { isMutative, isRead } from "./schema-type.ts"

it("names create and update a write's, read and readPartial a read's", () => {
	expect((["create", "update", "read", "readPartial"] as const).map(isMutative)).toEqual([true, true, false, false])
	expect((["create", "update", "read", "readPartial"] as const).map(isRead)).toEqual([false, false, true, true])
})
