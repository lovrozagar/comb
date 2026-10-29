/**
 * C21 of the 0.14.1 review: combDatabaseErrorKeys is the set the database classifiers answer with,
 * no more and no fewer, read from the modules that classify: each SQLite and Postgres module, D1's
 * error handler, and the value errors they share.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { combDatabaseErrorKeys, combErrorKeys } from "../../src/types.ts"

const SRC = join(import.meta.dirname, "../../src")
const CLASSIFYING = [
	...readdirSync(join(SRC, "sqlite")).map((name) => `sqlite/${name}`),
	...readdirSync(join(SRC, "pg")).map((name) => `pg/${name}`),
	"sqlite/d1/error-handler.ts",
	"value-error.ts",
].filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))

describe("combDatabaseErrorKeys", () => {
	it("is every key the database classifiers answer with, and no other", () => {
		const used = new Set(
			CLASSIFYING.flatMap((file) =>
				[...readFileSync(join(SRC, file), "utf8").matchAll(/combErrorKeys\.([A-Z_]+)/g)].map(
					(match) => combErrorKeys[match[1] as keyof typeof combErrorKeys],
				),
			),
		)
		expect([...combDatabaseErrorKeys].toSorted()).toEqual([...used].toSorted())
	})
})
