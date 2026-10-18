/**
 * Atlas writes `ALTER TYPE … ADD VALUE` into the same file as the statements that use the new
 * value, and Postgres refuses that inside one transaction ("unsafe use of new value", 55P04), so
 * the file fails on apply although the dev replay passed. comb moves the ADD VALUE statements into
 * a file of their own at the migration's version and the rest to the next second, each its own
 * transaction.
 */
import { nextVersion } from "./atlas-dir.ts"
import { atlasDirectives, withDirectivesFirst } from "./pg-objects.ts"
import { codeOf } from "./sql-code.ts"
import { splitSqlStatements } from "./sql-scan.ts"

const ADD_VALUE = /^ALTER TYPE \S+ ADD VALUE\b/i
const VERSIONED = /^(\d{14})(.*)\.sql$/

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
		[`${nextVersion(version)}${suffix}.sql`, withDirectivesFirst(head, joined(rest))],
	]
}

export { splitEnumValues }
