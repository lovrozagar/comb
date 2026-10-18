/**
 * Atlas writes `ALTER TYPE … ADD VALUE` into the same file as the statements that use the new
 * value, and Postgres refuses that inside one transaction ("unsafe use of new value", 55P04), so
 * the file fails on apply although the dev replay passed. comb moves the ADD VALUE statements into
 * a file of their own at the migration's version and the rest to the next second, each its own
 * transaction.
 */
import { atlasDirectives } from "./pg-objects.ts"
import { codeOf } from "./sql-code.ts"
import { splitSqlStatements } from "./sql-scan.ts"

const ADD_VALUE = /^ALTER TYPE \S+ ADD VALUE\b/i
const VERSIONED = /^(\d{14})(.*)\.sql$/

/** The version one second after `version` (YYYYMMDDHHMMSS, UTC) */
function nextVersion(version: string): string {
	const at = (from: number, to: number) => Number(version.slice(from, to))
	const next = new Date(Date.UTC(at(0, 4), at(4, 6) - 1, at(6, 8), at(8, 10), at(10, 12), at(12, 14) + 1))
	return next.toISOString().replace(/\D/g, "").slice(0, 14)
}

const joined = (statements: readonly string[]) => `${statements.join(";\n")};\n`

/** The files a migration becomes: itself, or its ADD VALUE statements first and the rest a version later */
function splitEnumValues(name: string, file: string): Array<[string, string]> {
	const [, version, suffix] = VERSIONED.exec(name) ?? []
	const head = atlasDirectives(file)
	const statements = splitSqlStatements(file.slice(head.length), "postgres")
	const values = statements.filter((stmt) => ADD_VALUE.test(codeOf(stmt, "postgres")))
	const rest = statements.filter((stmt) => !values.includes(stmt))
	if (version === undefined || values.length === 0 || rest.length === 0) return [[name, file]]
	return [
		[`${version}${suffix}_enum_values.sql`, joined(values)],
		[`${nextVersion(version)}${suffix}.sql`, head + joined(rest)],
	]
}

export { splitEnumValues }
