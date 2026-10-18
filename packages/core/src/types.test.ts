import { describe, expect, it } from "vitest"
import { combErrorKeys, statusKeyToCode } from "./types.ts"

describe("statusKeyToCode", () => {
	it("maps every status key to its HTTP code", () => {
		expect(statusKeyToCode).toEqual({
			bad_request: 400,
			conflict: 409,
			forbidden: 403,
			internal_server_error: 500,
			service_unavailable: 503,
			unprocessable_entity: 422,
		})
	})
})

describe("combErrorKeys", () => {
	it("are lower snake case and unique: a consumer keys i18n maps by them", () => {
		const values = Object.values(combErrorKeys)
		expect(values.every((key) => /^[a-z]+(?:_[a-z]+)*$/.test(key))).toBe(true)
		expect(new Set(values).size).toBe(values.length)
	})
})
