import { describe, expect, it } from "vitest"
import { readTableOptions } from "./analyze-options.ts"
import { createProject } from "./utils/ts-morph.ts"

/** readTableOptions on the third argument of the table in `source`. */
function optionsOf(source: string) {
	const file = createProject().createSourceFile("x.ts", source)
	const node = file.getFirstDescendant((n) => n.getKindName() === "ArrowFunction")
	return readTableOptions(node)
}

describe("readTableOptions", () => {
	it("reads composite keys, plain unique indexes and CHECKs from the array form", () => {
		expect(
			optionsOf(`const t = sqliteTable("t", {}, (x) => [
	primaryKey({ columns: [x.a, x.b] }),
	uniqueIndex("t_a_b").on(x.a, x.b),
	check("t_n_pos", sql\`
		n >   0
	\`),
	index("t_c").on(x.c),
])`),
		).toEqual({
			checkConstraints: [{ expression: "n > 0", name: "t_n_pos" }],
			hasCompositePrimaryKey: true,
			partialUniqueIndexes: [],
			uniqueIndexes: [{ columns: ["a", "b"], name: "t_a_b" }],
		})
	})

	it("reads the object form and a body in parentheses", () => {
		expect(
			optionsOf(`const t = sqliteTable("t", {}, (t) => ({ ...shared, u: uniqueIndex("t_u").on(t.u), x: other }))`),
		).toEqual({
			checkConstraints: [],
			hasCompositePrimaryKey: false,
			partialUniqueIndexes: [],
			uniqueIndexes: [{ columns: ["u"], name: "t_u" }],
		})
	})

	it("keeps a partial unique index apart and leaves out expression indexes and malformed calls", () => {
		const options = optionsOf(`const t = sqliteTable("t", {}, (t) => [
	uniqueIndex("lower_email").on(sql\`lower(\${t.email})\`),
	uniqueIndex("live_slug").on(t.slug).where(sql\`deleted_at is null\`),
	uniqueIndex("other_table").on(u.x),
	uniqueIndex("no_columns").on(),
	uniqueIndex(name).on(t.a),
	uniqueIndex("no_on"),
])`)
		expect(options).toEqual({
			checkConstraints: [],
			hasCompositePrimaryKey: false,
			partialUniqueIndexes: [{ columns: ["slug"], name: "live_slug" }],
			uniqueIndexes: [],
		})
	})

	it("is empty without an arrow function or an option list", () => {
		expect(optionsOf(`const t = sqliteTable("t", {})`)).toEqual({
			checkConstraints: [],
			hasCompositePrimaryKey: false,
			partialUniqueIndexes: [],
			uniqueIndexes: [],
		})
		expect(optionsOf(`const t = sqliteTable("t", {}, () => buildOptions())`).uniqueIndexes).toEqual([])
	})
})

/* the CHECK shapes the consumers write, each check(name, sql.raw("…")), one across lines as the formatter leaves it (C4) */
const CONSUMER_CHECKS: Array<[string, string]> = [
	["email_requires_password", "provider != 'email' OR _password IS NOT NULL"],
	["refresh_token_expiry_valid", "expires_at > created_at"],
	[
		"revoked_fields_integrity",
		"(revoked_at IS NULL AND revoked_reason IS NULL) OR (revoked_at IS NOT NULL AND revoked_reason IS NOT NULL)",
	],
	["backup_codes_size", "_backup_codes IS NULL OR length(_backup_codes) <= 10240"],
	["verified_requires_verified_at", "verified = 0 OR verified_at IS NOT NULL"],
	["oauth_expiry_valid", "expires_at > created_at"],
	["link_label_requires_url", "link_label IS NULL OR link_url IS NOT NULL"],
	["merge_requires_merge_mode", "insert_mode != 'merge' OR merge_columns_json IS NOT NULL"],
	["credits_positive", "credits >= 1"],
	["credits_used_in_range", "credits_used >= 0 AND credits_used <= credits"],
	["grant_revoked_after_granted", "revoked_at IS NULL OR revoked_at >= granted_at"],
	["cite_size", "length(cite) <= 2048"],
	["areas_size", "length(areas) <= 16384"],
	["payload_size", "length(payload) <= 32768"],
	["template_raw", "n > 0"],
]

describe("readTableOptions on sql.raw CHECKs (C4)", () => {
	it("reads each consumer CHECK shape by name and SQL", () => {
		const options = optionsOf(`const t = sqliteTable("t", {}, (x) => [
${CONSUMER_CHECKS.slice(0, -2)
	.map(([name, text]) => `\tcheck(${JSON.stringify(name)}, sql.raw(${JSON.stringify(text)})),`)
	.join("\n")}
	check(
		"${CONSUMER_CHECKS.at(-2)?.[0]}",
		sql.raw(
			"${CONSUMER_CHECKS.at(-2)?.[1]}",
		),
	),
	check("template_raw", sql.raw(\`n > 0\`)),
])`)
		expect(options.checkConstraints).toEqual(CONSUMER_CHECKS.map(([name, expression]) => ({ expression, name })))
	})

	it.each([
		["a string for SQL", 'check("no_sql", "n > 0")'],
		["a name that is no literal", "check(name, sql`n > 0`)"],
		["sql.raw of a variable", 'check("dynamic", sql.raw(text))'],
		["another tag", 'check("other", raw`n > 0`)'],
	])("fails codegen on a check() with %s, naming its place", (_, call) => {
		expect(() => optionsOf(`const t = sqliteTable("t", {}, (x) => [\n\t${call},\n])`)).toThrow(
			/x\.ts:2: comb cannot read check\(/,
		)
	})
})
