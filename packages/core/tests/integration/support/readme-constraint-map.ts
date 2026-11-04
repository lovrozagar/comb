/**
 * QE4 of r22b: README's constraint-map example, read from the README as a reader copies it, and
 * the schema it maps, so a test runs the map through a dialect's classifier as written.
 */
import fs from "node:fs"
import path from "node:path"
import type { ConstraintMap } from "../../../src/types.ts"

const README = fs.readFileSync(path.join(import.meta.dirname, "../../../../../README.md"), "utf8")
const DECLARATION = "export const authorConstraints: ConstraintMap = "

/** The map README's "Constraint maps" block declares, evaluated as the object literal it is */
export function readmeConstraintMap(): ConstraintMap {
	const code = [...README.matchAll(/```ts\n([\s\S]*?)\n```/g)]
		.map((match) => match[1] as string)
		.find((block) => block.includes(DECLARATION))
	if (code === undefined) throw new Error("README has no block declaring authorConstraints")
	const literal = code.slice(code.indexOf(DECLARATION) + DECLARATION.length)
	return new Function(`return (${literal})`)() as ConstraintMap
}

/**
 * The tables README's map is written for: a unique email, an org reference and a named locale CHECK.
 * author also references team, a key the map leaves out, so the org case holds only while README keys
 * org_id by its column, which SQLite's message never names (AB11 of area B)
 */
export const README_MAP_DDL = [
	"CREATE TABLE org (id TEXT PRIMARY KEY)",
	"CREATE TABLE team (id TEXT PRIMARY KEY)",
	`CREATE TABLE author (
		id TEXT PRIMARY KEY,
		email TEXT NOT NULL,
		org_id TEXT REFERENCES org(id),
		team_id TEXT REFERENCES team(id),
		locale TEXT,
		CONSTRAINT author_locale_check CHECK (locale IN ('en', 'hr'))
	)`,
	"CREATE UNIQUE INDEX idx_author_email ON author (email)",
	"INSERT INTO org VALUES ('o1')",
	"INSERT INTO author (id, email, org_id, locale) VALUES ('a1', 'taken@x', 'o1', 'en')",
]

/** Each violation of README's map and the error the map turns it into */
export const README_MAP_CASES = [
	{
		errorKey: "email_already_registered",
		label: "a duplicate email",
		statement: "INSERT INTO author (id, email) VALUES ('a2', 'taken@x')",
		status: 409,
	},
	{
		errorKey: "org_not_found",
		label: "a missing org",
		statement: "INSERT INTO author (id, email, org_id) VALUES ('a3', 'b@x', 'nope')",
		status: 409,
	},
	{
		errorKey: "locale_invalid",
		label: "a bad locale",
		statement: "INSERT INTO author (id, email, locale) VALUES ('a4', 'c@x', 'xx')",
		status: 400,
	},
	{
		errorKey: "foreign_key_violation",
		label: "a missing team, a key the map leaves out",
		statement: "INSERT INTO author (id, email, team_id) VALUES ('a5', 'd@x', 'nope')",
		status: 409,
	},
] as const
