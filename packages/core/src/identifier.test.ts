import { describe, expect, it } from "vitest"
import { PG_IDENTIFIER_BYTES, pgIdentifier, truncateUtf8 } from "./identifier.ts"

describe("truncateUtf8 and pgIdentifier", () => {
	it("cuts a name to its bytes, never inside a character, as Postgres does past 63", () => {
		expect(PG_IDENTIFIER_BYTES).toBe(63)
		expect(truncateUtf8("abcdef", 4)).toBe("abcd")
		/* é is two bytes: a cut at three keeps one of them whole */
		expect(truncateUtf8("éé", 3)).toBe("é")
		expect(pgIdentifier("x".repeat(70))).toBe("x".repeat(63))
		expect(pgIdentifier("short")).toBe("short")
	})
})
